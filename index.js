#!/usr/bin/env node
/**
 * Punto de entrada del addon de Stremio.
 *
 * - `npm start` (o `node index.js`) levanta el servidor HTTP en `PORT` (7000
 *   por defecto) escuchando en 0.0.0.0, listo para Beamup o cualquier PaaS.
 * - `createAddon()` devuelve la app Express + SDK sin escuchar, útil para tests
 *   o despliegues serverless (basta exportarla como handler).
 * - `registerProcessGuards()` instala escuchas de `unhandledRejection` y
 *   `uncaughtException` para que un fallo aislado no apague el proceso.
 *
 * Los scrapers se registran en `src/scrapers/registry.js` y el orquestador los
 * ejecuta en paralelo para el endpoint `/stream/:type/:id.json`. El resto de
 * handlers (catálogo y meta) siguen siendo inyectables y devuelven vacío si no
 * se configuran.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp, startServer } from './src/core/server.js';
import { createManifest } from './src/core/manifest.js';
import { listSources } from './src/config/sources.js';
import { StreamOrchestrator } from './src/services/stream.orchestrator.js';
import { getActiveScrapers } from './src/scrapers/registry.js';

export {
	createApp,
	startServer,
	createAddonInterface,
	createProxyStreamHandler,
	buildProxyStreamUrl
} from './src/core/server.js';
export { createManifest, manifest } from './src/core/manifest.js';
export { BaseScraper, USER_AGENTS, REQUEST_TIMEOUT_MS } from './src/scrapers/base.scraper.js';
export {
	TitleResolver,
	createResolver,
	resolveTitle,
	resolver as titleResolver,
	parseStremioId
} from './src/services/resolver.service.js';
export {
	sanitizeForUrl,
	slugify,
	normalizeTitle,
	stripAccents
} from './src/utils/sanitizer.js';
export {
	StreamOrchestrator,
	createStreamOrchestrator,
	dedupeStreams,
	sanitizeStream,
	emptyStreams
} from './src/services/stream.orchestrator.js';
export {
	SCRAPER_CATEGORIES,
	registerScraper,
	registerScrapers,
	unregisterScraper,
	listScrapers,
	getActiveScrapers
} from './src/scrapers/registry.js';
export {
	SOURCES,
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	getSource,
	listSources,
	resolveMirrors
} from './src/config/sources.js';

/**
 * Construye la app del addon, el orquestador de streams y su endpoint de salud.
 *
 * El handler de `/stream` se conecta automáticamente al orquestador; se puede
 * sustituir con `options.handlers.stream` o inyectar un orquestador propio.
 *
 * @param {Object} [options]
 * @param {any} [options.manifest]       Manifest a servir.
 * @param {Object} [options.handlers]    `{ catalog, meta, stream }`.
 * @param {object} [options.orchestrator] Instancia de `StreamOrchestrator`.
 * @param {Array<object>} [options.scrapers] Scrapers; por defecto, los registrados.
 * @param {boolean|object} [options.proxy] Configuración de `/proxy-stream`.
 * @param {() => any} [options.getHealth] Datos extra para `/health`.
 * @param {Pick<Console, 'info' | 'warn' | 'error'>} [options.logger]
 * @param {boolean} [options.landing]    Página HTML en `/`.
 * @returns {import('express').Express}
 */
export function createAddon(options = {}) {
	const logger = options.logger ?? console;

	const orchestrator =
		options.orchestrator ??
		new StreamOrchestrator({
			scrapers: options.scrapers ?? getActiveScrapers(),
			logger
		});

	const handlers = {
		...options.handlers,
		stream: options.handlers?.stream ?? ((context) => orchestrator.getStreams(context))
	};

	const getHealth = () => {
		const base = options.getHealth ? options.getHealth() : sourcesHealth();
		return { ...base, streams: orchestrator.health() };
	};

	const app = createApp({
		manifest: options.manifest ?? createManifest(),
		handlers,
		getHealth,
		proxy: options.proxy,
		logger,
		landing: options.landing
	});

	// Accesible para inspección/tests sin acoplar el resto del código.
	app.locals.streamOrchestrator = orchestrator;

	return app;
}

/**
 * Estado de configuración de las fuentes para `/health`.
 *
 * @returns {{ sources: Array<{ id: string, name: string, category: string, enabled: boolean, mirrors: number }> }}
 */
export function sourcesHealth() {
	const all = listSources({ enabledOnly: false });

	return {
		sources: all.map((source) => ({
			id: source.id,
			name: source.name,
			category: source.category,
			enabled: source.enabled,
			mirrors: source.mirrors.length
		}))
	};
}

/**
 * Arranca el addon como proceso de larga duración.
 *
 * @param {{ port?: number, host?: string }} [options]
 * @returns {{ app: import('express').Express, server: import('node:http').Server }}
 */
export function main(options = {}) {
	const port = Number(options.port ?? process.env.PORT) || 7000;
	const host = options.host ?? process.env.HOST ?? '0.0.0.0';

	registerProcessGuards();

	const sources = listSources();
	console.info(
		`[addon] fuentes activas: ${sources.length > 0 ? sources.map((source) => source.id).join(', ') : 'ninguna'}`
	);

	const app = options.app ?? createAddon(options);

	const orchestrator = app.locals?.streamOrchestrator;
	if (orchestrator) {
		const scrapers = orchestrator.health().scrapers.filter((scraper) => scraper.enabled);
		console.info(
			`[addon] scrapers activos: ${scrapers.length > 0 ? scrapers.map((scraper) => scraper.id).join(', ') : 'ninguno'}`
		);
	}

	const { server } = startServer({ port, host, app });

	registerShutdown(server);

	return { app, server };
}

/**
 * Cierre ordenado: deja de aceptar conexiones y fuerza la salida a los 8 s.
 *
 * @param {import('node:http').Server} server
 */
function registerShutdown(server) {
	let closing = false;

	const shutdown = (signal) => {
		if (closing) return;
		closing = true;
		console.info(`[addon] ${signal} recibido; cerrando servidor...`);

		const forceExit = setTimeout(() => {
			console.warn('[addon] no se pudo cerrar a tiempo; saliendo.');
			process.exit(1);
		}, 8000);
		forceExit.unref?.();

		server.close((error) => {
			clearTimeout(forceExit);
			if (error) {
				console.error(`[addon] error al cerrar: ${error.message}`);
				process.exit(1);
			}
			console.info('[addon] servidor cerrado.');
			process.exit(0);
		});
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

let processGuardsInstalled = false;

/**
 * Instala escuchas de seguridad globales para que un fallo aislado no apague
 * el proceso de Node (Beamup reiniciaría el addon y Stremio vería errores).
 *
 * - `unhandledRejection`: se registra y se continúa.
 * - `uncaughtException`: se registra y se continúa (por defecto). Un estado
 *   inconsistente es posible, pero la prioridad del addon es seguir sirviendo;
 *   con `EXIT_ON_UNCAUGHT_EXCEPTION=true` se sale con código 1.
 *
 * La instalación es idempotente: llamarla varias veces no duplica escuchas.
 *
 * @returns {boolean} `true` si las escuchas se instalaron en esta llamada.
 */
export function registerProcessGuards() {
	if (processGuardsInstalled) return false;
	processGuardsInstalled = true;

	process.on('unhandledRejection', (reason) => {
		console.warn(`[addon] promesa rechazada sin manejar: ${reason?.stack ?? reason}`);
	});

	process.on('uncaughtException', (error) => {
		console.error(`[addon] excepción no capturada: ${error?.stack ?? error}`);

		if (process.env.EXIT_ON_UNCAUGHT_EXCEPTION === 'true') {
			process.exit(1);
		}
	});

	return true;
}

/** `true` si el módulo se ejecutó directamente (`node index.js`). */
function isDirectRun() {
	const entry = process.argv[1];
	if (!entry) return false;

	try {
		return import.meta.url === pathToFileURL(resolve(entry)).href;
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	main();
}

export default createAddon;
