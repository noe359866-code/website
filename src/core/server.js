/**
 * Servidor HTTP del addon (Express).
 *
 * Expone el protocolo Stremio:
 *   GET /manifest.json
 *   GET /catalog/:type/:id.json
 *   GET /catalog/:type/:id/:extra.json
 *   GET /meta/:type/:id.json
 *   GET /stream/:type/:id.json
 *
 * Los handlers se inyectan desde `index.js` (o desde tests) con la firma
 * `async ({ type, id, extra, req }) => response`. Si un handler falla o tarda,
 * el endpoint responde 200 con un resultado vacío para no romper el cliente.
 */

import express from 'express';
import { createManifest, validateManifest } from './manifest.js';

/** Respuestas vacías válidas del protocolo Stremio. */
export const EMPTY_RESULTS = Object.freeze({
	catalog: { metas: [] },
	meta: { meta: null },
	stream: { streams: [] }
});

/** Handlers por defecto: el addon queda operativo (aunque vacío) desde el minuto cero. */
const DEFAULT_HANDLERS = Object.freeze({
	catalog: async () => EMPTY_RESULTS.catalog,
	meta: async () => EMPTY_RESULTS.meta,
	stream: async () => EMPTY_RESULTS.stream
});

/**
 * Crea la app Express con todas las rutas del addon.
 *
 * @param {Object} [options]
 * @param {any} [options.manifest] Manifest ya construido (por defecto `createManifest()`).
 * @param {Partial<typeof DEFAULT_HANDLERS>} [options.handlers]
 * @param {() => any} [options.getHealth] Datos extra para `/health` (p. ej. scrapers).
 * @param {Pick<Console, 'info' | 'warn' | 'error'>} [options.logger=console]
 * @param {boolean} [options.landing=true] Sirve una página HTML informativa en `/`.
 * @returns {import('express').Express}
 */
export function createApp(options = {}) {
	const manifest = options.manifest ? options.manifest : createManifest();
	validateManifest(manifest);

	const handlers = { ...DEFAULT_HANDLERS, ...(options.handlers ?? {}) };
	const logger = options.logger ?? console;
	const landing = options.landing !== false;

	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', true);
	app.use(express.json({ limit: '256kb' }));
	app.use(corsMiddleware);

	app.get('/manifest.json', (req, res) => {
		res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
		res.type('application/json').send(JSON.stringify(manifest));
	});

	app.get(
		['/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json'],
		resourceHandler('catalog', handlers.catalog, logger)
	);

	app.get(['/meta/:type/:id.json', '/meta/:type/:id/:extra.json'], resourceHandler('meta', handlers.meta, logger));

	app.get(
		['/stream/:type/:id.json', '/stream/:type/:id/:extra.json'],
		resourceHandler('stream', handlers.stream, logger)
	);

	app.get('/health', (req, res) => {
		let extra = {};
		try {
			extra = options.getHealth ? options.getHealth() : {};
		} catch (error) {
			logger.warn?.(`[addon] getHealth falló: ${error?.message ?? error}`);
		}

		res.set('Cache-Control', 'no-store');
		res.json({
			status: 'ok',
			addon: manifest.id,
			version: manifest.version,
			uptimeSeconds: Math.round(process.uptime()),
			timestamp: new Date().toISOString(),
			...extra
		});
	});

	if (landing) {
		app.get('/', (req, res) => {
			const baseUrl = getBaseUrl(req);
			res.type('html').send(renderLanding(manifest, baseUrl));
		});
	}

	// 404 JSON coherente para todo lo demás.
	app.use((req, res) => {
		res.status(404).json({
			error: 'not_found',
			message: `Ruta no encontrada: ${req.method} ${req.path}`
		});
	});

	// Error handler final: nunca filtramos stack traces al cliente.
	app.use((error, req, res, next) => {
		logger.error?.(`[addon] error no controlado en ${req.method} ${req.path}: ${error?.stack ?? error}`);
		if (res.headersSent) return next(error);
		res.status(500).json({ error: 'internal_error', message: 'Error interno del addon.' });
	});

	return app;
}

/**
 * Construye el middleware de un recurso Stremio.
 *
 * @param {'catalog' | 'meta' | 'stream'} name
 * @param {(context: { type: string, id: string, extra: Record<string, string>, req: import('express').Request }) => Promise<any>} handler
 * @param {Pick<Console, 'warn'>} logger
 * @returns {import('express').RequestHandler}
 */
function resourceHandler(name, handler, logger) {
	return async (req, res) => {
		const { type, id, extra: rawExtra } = req.params;
		const extra = parseExtra(rawExtra);

		res.set('Cache-Control', 'public, max-age=60');

		try {
			const result = await handler({ type, id, extra, req });
			res.json(result ?? EMPTY_RESULTS[name]);
		} catch (error) {
			// El cliente Stremio no maneja bien los 5xx: devolvemos vacío y avisamos.
			logger.warn?.(
				`[addon] handler "${name}" falló para ${type}/${id}: ${error?.message ?? error}`
			);
			res.json(EMPTY_RESULTS[name]);
		}
	};
}

/**
 * Parsea el segmento extra de Stremio (`search=one%20piece&skip=0`).
 *
 * @param {string | undefined} segment
 * @returns {Record<string, string>}
 */
export function parseExtra(segment) {
	if (!segment) return {};

	const params = new URLSearchParams(segment);
	const extra = {};
	for (const [key, value] of params.entries()) extra[key] = value;

	return extra;
}

/**
 * URL absoluta del addon a partir de la petición (respeta proxies de Beamup).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getBaseUrl(req) {
	return `${req.protocol}://${req.get('host')}`;
}

/**
 * Enlace de instalación para el cliente Stremio de escritorio.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function getInstallUrl(baseUrl) {
	return `stremio://${baseUrl.replace(/^https?:\/\//, '')}/manifest.json`;
}

/**
 * Levanta el servidor HTTP.
 *
 * @param {Object} [options] Opciones de `createApp` + red.
 * @param {number} [options.port] Puerto (por defecto `PORT` o 7000).
 * @param {string} [options.host] Interfaz (por defecto 0.0.0.0 para contenedores).
 * @returns {{ app: import('express').Express, server: import('node:http').Server }}
 */
export function startServer(options = {}) {
	const {
		port = Number(process.env.PORT) || 7000,
		host = process.env.HOST || '0.0.0.0',
		logger = console,
		...appOptions
	} = options;

	const app = createApp({ ...appOptions, logger });
	const server = app.listen(port, host, () => {
		const address = server.address();
		const actualPort = typeof address === 'object' && address ? address.port : port;
		logger.info?.(`[addon] escuchando en http://${host}:${actualPort}`);
		logger.info?.(`[addon] manifest: http://${host}:${actualPort}/manifest.json`);
	});

	server.on('error', (error) => {
		logger.error?.(`[addon] error del servidor: ${error?.message ?? error}`);
	});

	return { app, server };
}

/** Cabeceras CORS: el cliente web de Stremio las exige. */
function corsMiddleware(req, res, next) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	res.setHeader('Access-Control-Max-Age', '86400');

	if (req.method === 'OPTIONS') {
		res.sendStatus(204);
		return;
	}

	next();
}

/**
 * Página HTML mínima con el enlace de instalación y los endpoints disponibles.
 *
 * @param {any} manifest
 * @param {string} baseUrl
 * @returns {string}
 */
function renderLanding(manifest, baseUrl) {
	const installUrl = getInstallUrl(baseUrl);
	const endpointList = [
		'/manifest.json',
		'/catalog/:type/:id.json',
		'/meta/:type/:id.json',
		'/stream/:type/:id.json',
		'/health'
	];

	return `<!doctype html>
<html lang="es">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(manifest.name)}</title>
	<style>
		:root { color-scheme: dark; }
		body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0e14; color: #e6e6e6; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
		main { width: min(720px, 92vw); padding: 40px; border: 1px solid #1e2533; border-radius: 16px; background: #11151f; }
		h1 { margin: 0 0 8px; font-size: 1.6rem; }
		p { color: #a7b0c0; line-height: 1.6; }
		a.button { display: inline-block; margin: 16px 0 24px; padding: 12px 20px; border-radius: 10px; background: #7b5cff; color: #fff; text-decoration: none; font-weight: 600; }
		code { background: #0b0e14; border: 1px solid #1e2533; border-radius: 6px; padding: 2px 6px; font-size: 0.85em; }
		ul { padding-left: 18px; color: #a7b0c0; }
		li { margin: 6px 0; }
		small { color: #6f7a8c; }
	</style>
</head>
<body>
	<main>
		<h1>${escapeHtml(manifest.name)}</h1>
		<p>${escapeHtml(manifest.description ?? '')}</p>
		<p>Versión <code>${escapeHtml(manifest.version)}</code> · id <code>${escapeHtml(manifest.id)}</code></p>
		<a class="button" href="${escapeHtml(installUrl)}">Instalar en Stremio</a>
		<p><small>Endpoints disponibles:</small></p>
		<ul>
			${endpointList.map((endpoint) => `<li><code>${escapeHtml(endpoint)}</code></li>`).join('\n')}
		</ul>
		<p><small>Manifest: <code>${escapeHtml(baseUrl)}/manifest.json</code></small></p>
	</main>
</body>
</html>`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export default createApp;
