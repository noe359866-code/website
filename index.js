#!/usr/bin/env node
/**
 * Punto de entrada del addon de Stremio.
 *
 * - `npm start` (o `node index.js`) levanta el servidor HTTP en `PORT` (7000
 *   por defecto) escuchando en 0.0.0.0, listo para Beamup o cualquier PaaS.
 * - `createAddon()` devuelve la app Express sin escuchar, útil para tests o
 *   despliegues serverless (basta exportarla como handler).
 *
 * Aquí se conectan los scrapers con los handlers de Stremio. Por ahora los
 * handlers devuelven resultados vacíos; a medida que se implementen scrapers
 * (extendiendo `BaseScraper`), se registran en `handlers`.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp, startServer } from './src/core/server.js';
import { createManifest } from './src/core/manifest.js';
import { listSources } from './src/config/sources.js';

export { createApp, startServer } from './src/core/server.js';
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
	SOURCES,
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	getSource,
	listSources,
	resolveMirrors
} from './src/config/sources.js';

/**
 * Construye la app del addon con sus handlers y su endpoint de salud.
 *
 * @param {Object} [options]
 * @param {any} [options.manifest]       Manifest a servir.
 * @param {Object} [options.handlers]    `{ catalog, meta, stream }`.
 * @param {() => any} [options.getHealth] Datos extra para `/health`.
 * @param {Pick<Console, 'info' | 'warn' | 'error'>} [options.logger]
 * @param {boolean} [options.landing]    Página HTML en `/`.
 * @returns {import('express').Express}
 */
export function createAddon(options = {}) {
	return createApp({
		manifest: options.manifest ?? createManifest(),
		handlers: options.handlers ?? {},
		getHealth: options.getHealth ?? sourcesHealth,
		logger: options.logger ?? console,
		landing: options.landing
	});
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

	const sources = listSources();
	console.info(
		`[addon] fuentes activas: ${sources.length > 0 ? sources.map((source) => source.id).join(', ') : 'ninguna'}`
	);

	const { app, server } = startServer({
		port,
		host,
		getHealth: sourcesHealth
	});

	registerShutdown(server);
	registerProcessGuards();

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

/** Evita que un rechazo no controlado tumbe el proceso sin dejar rastro. */
function registerProcessGuards() {
	process.on('unhandledRejection', (reason) => {
		console.warn(`[addon] promesa rechazada sin manejar: ${reason?.stack ?? reason}`);
	});

	process.on('uncaughtException', (error) => {
		console.error(`[addon] excepción no capturada: ${error?.stack ?? error}`);
		process.exit(1);
	});
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
