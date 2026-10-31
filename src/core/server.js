/**
 * Servidor HTTP del addon: Express + `stremio-addon-sdk`.
 *
 * - El protocolo Stremio (`/manifest.json`, `/catalog`, `/meta`, `/stream`) lo
 *   sirve el router oficial del SDK (`addonBuilder` + `getRouter`).
 * - Express añade `/health`, la landing y el proxy opcional `/proxy-stream`.
 * - Todos los handlers se envuelven para responder resultados vacíos válidos en
 *   vez de propagar errores al SDK (que respondería 500).
 *
 * Proxy `/proxy-stream`:
 *   GET /proxy-stream?url=<url>&referer=<opcional>&ua=<opcional>
 *   Reenvía la petición inyectando `Referer` y `User-Agent` de navegador y
 *   transmite la respuesta con `responseType: 'stream'` (sin bufferizar), por
 *   lo que soporta Range/seek y archivos grandes.
 *
 *   Seguridad: solo http/https, bloqueo de hosts/IPs privadas (SSRF), sin
 *   credenciales en la URL y allowlist opcional `PROXY_ALLOWED_HOSTS`.
 *   Se puede desactivar con `ENABLE_STREAM_PROXY=false`.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

import axios from 'axios';
import express from 'express';
import stremioAddonSdk from 'stremio-addon-sdk';

import { createManifest, validateManifest } from './manifest.js';
import { USER_AGENTS } from '../scrapers/base.scraper.js';

const { addonBuilder, getRouter } = stremioAddonSdk;

/** Respuestas vacías válidas del protocolo Stremio. */
export const EMPTY_RESULTS = Object.freeze({
	catalog: Object.freeze({ metas: [] }),
	meta: Object.freeze({ meta: null }),
	stream: Object.freeze({ streams: [] })
});

/** Handlers por defecto: el addon queda operativo (aunque vacío) desde el minuto cero. */
const DEFAULT_HANDLERS = Object.freeze({
	catalog: async () => ({ metas: [] }),
	meta: async () => ({ meta: null }),
	stream: async () => ({ streams: [] })
});

/** Cabeceras de la respuesta del upstream que sí se reenvían al cliente. */
const FORWARDED_RESPONSE_HEADERS = Object.freeze([
	'content-type',
	'content-length',
	'content-range',
	'accept-ranges',
	'content-encoding',
	'content-disposition',
	'last-modified',
	'etag',
	'cache-control',
	'expires',
	'vary'
]);

/** Cabeceras de la petición del cliente que se reenvían al upstream. */
const FORWARDED_REQUEST_HEADERS = Object.freeze([
	'range',
	'if-range',
	'if-none-match',
	'if-modified-since'
]);

const DEFAULT_PROXY_TIMEOUT_MS = 30_000;
const MAX_PROXY_REDIRECTS = 3;

/* ---------------------------------------------------------------------- *
 * Addon interface (SDK oficial)
 * ---------------------------------------------------------------------- */

/**
 * Construye la interfaz del addon con `addonBuilder` del SDK.
 *
 * Los handlers se envuelven para que nunca rechacen: si uno falla o devuelve
 * una estructura inválida, se responde el resultado vacío correspondiente y el
 * SDK devuelve 200 en lugar de 500.
 *
 * @param {Object} [options]
 * @param {any} [options.manifest] Manifest ya validado.
 * @param {Record<string, Function>} [options.handlers] `{ catalog, meta, stream }`.
 * @param {Pick<Console, 'warn' | 'info' | 'error'>} [options.logger]
 * @returns {{ manifest: any, get: Function }}
 */
export function createAddonInterface({ manifest = createManifest(), handlers = {}, logger = console } = {}) {
	validateManifest(manifest);

	const builder = addonBuilder(manifest);
	const safeHandlers = { ...DEFAULT_HANDLERS, ...handlers };

	builder.defineCatalogHandler(wrapHandler('catalog', safeHandlers.catalog, logger));
	builder.defineMetaHandler(wrapHandler('meta', safeHandlers.meta, logger));
	builder.defineStreamHandler(wrapHandler('stream', safeHandlers.stream, logger));

	return builder.getInterface();
}

/**
 * @param {'catalog'|'meta'|'stream'} name
 * @param {Function} handler
 * @param {Pick<Console, 'warn'>} logger
 * @returns {(args: { type?: string, id?: string, extra?: object, config?: object }) => Promise<object>}
 */
function wrapHandler(name, handler, logger) {
	return async (args = {}) => {
		const context = {
			type: args.type,
			id: args.id,
			// El SDK parsea `extra` con qs: se copia a un objeto plano.
			extra: { ...(args.extra && typeof args.extra === 'object' ? args.extra : {}) },
			config: { ...(args.config && typeof args.config === 'object' ? args.config : {}) }
		};

		try {
			const result = await handler(context);
			return normalizeResult(name, result, logger);
		} catch (error) {
			logger.warn?.(`[addon] handler "${name}" falló: ${error?.message ?? error}. Se responde vacío.`);
			return emptyResult(name);
		}
	};
}

/**
 * Garantiza la forma del resultado y que sea serializable a JSON.
 *
 * @param {'catalog'|'meta'|'stream'} name
 * @param {any} result
 * @param {Pick<Console, 'warn'>} logger
 * @returns {object}
 */
function normalizeResult(name, result, logger) {
	try {
		const base = result && typeof result === 'object' && !Array.isArray(result) ? result : {};

		const payload =
			name === 'catalog'
				? { ...base, metas: Array.isArray(base.metas) ? base.metas : [] }
				: name === 'meta'
					? { ...base, meta: base.meta ?? null }
					: { ...base, streams: Array.isArray(base.streams) ? base.streams : [] };

		// Falla aquí (antes de que el SDK haga stringify) si hay ciclos/BigInt.
		JSON.stringify(payload);

		return payload;
	} catch (error) {
		logger.warn?.(`[addon] respuesta inválida de "${name}": ${error?.message ?? error}. Se responde vacío.`);
		return emptyResult(name);
	}
}

/**
 * @param {'catalog'|'meta'|'stream'} name
 * @returns {object}
 */
function emptyResult(name) {
	if (name === 'catalog') return { metas: [] };
	if (name === 'meta') return { meta: null };
	return { streams: [] };
}

/* ---------------------------------------------------------------------- *
 * App Express
 * ---------------------------------------------------------------------- */

/**
 * Crea la app Express con el router del SDK y los endpoints propios.
 *
 * @param {Object} [options]
 * @param {any} [options.manifest] Manifest a servir.
 * @param {Partial<typeof DEFAULT_HANDLERS>} [options.handlers]
 * @param {{ manifest: any, get: Function }} [options.addonInterface] Interfaz ya construida.
 * @param {() => any} [options.getHealth] Datos extra para `/health`.
 * @param {boolean|object} [options.proxy=true] Configuración de `/proxy-stream`.
 * @param {Pick<Console, 'info' | 'warn' | 'error'>} [options.logger=console]
 * @param {boolean} [options.landing=true] Página HTML informativa en `/`.
 * @returns {import('express').Express}
 */
export function createApp(options = {}) {
	const manifest = options.manifest ?? createManifest();
	validateManifest(manifest);

	const logger = options.logger ?? console;
	const handlers = { ...DEFAULT_HANDLERS, ...(options.handlers ?? {}) };
	const addonInterface =
		options.addonInterface ?? createAddonInterface({ manifest, handlers, logger });

	const proxy = resolveProxyConfig(options.proxy);

	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', true);
	app.use(express.json({ limit: '256kb' }));
	app.use(corsMiddleware);

	if (options.landing !== false) {
		app.get('/', (req, res) => {
			res.type('html').send(renderLanding(manifest, getBaseUrl(req), { proxy: proxy.enabled }));
		});
	}

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
			proxy: {
				enabled: proxy.enabled,
				allowedHosts: proxy.allowedHosts.length > 0 ? proxy.allowedHosts.length : null,
				allowPrivateNetworks: proxy.allowPrivateNetworks
			},
			...extra
		});
	});

	if (proxy.enabled) {
		app.get('/proxy-stream', createProxyStreamHandler({ ...proxy, logger }));
	}

	// Cabeceras de caché para el manifest que sirve el router del SDK.
	app.get('/manifest.json', (req, res, next) => {
		res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
		next();
	});

	// Rutas oficiales del protocolo Stremio (manifest + recursos).
	app.use(getRouter(addonInterface));

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

	app.locals.addonInterface = addonInterface;
	app.locals.proxy = {
		enabled: proxy.enabled,
		allowedHosts: proxy.allowedHosts
	};

	return app;
}

/**
 * Levanta el servidor HTTP.
 *
 * @param {Object} [options] Opciones de `createApp` + red.
 * @param {number} [options.port] Puerto (por defecto `PORT` o 7000).
 * @param {string} [options.host] Interfaz (por defecto 0.0.0.0 para contenedores).
 * @param {import('express').Express} [options.app] App ya construida.
 * @returns {{ app: import('express').Express, server: import('node:http').Server }}
 */
export function startServer(options = {}) {
	const {
		port = dynamicPort(),
		host = process.env.HOST || '0.0.0.0',
		logger = console,
		app: providedApp,
		...appOptions
	} = options;

	const app = providedApp ?? createApp({ ...appOptions, logger });

	const server = app.listen(port, host, () => {
		const address = server.address();
		const actualPort = typeof address === 'object' && address ? address.port : port;
		logger.info?.(`[addon] escuchando en http://${host}:${actualPort} (PORT=${process.env.PORT ?? 'no definido'})`);
		logger.info?.(`[addon] manifest: http://${host}:${actualPort}/manifest.json`);

		const proxy = app.locals?.proxy;
		logger.info?.(
			`[addon] proxy de streams: /proxy-stream ${proxy?.enabled ? 'activo' : 'desactivado'}`
		);
	});

	server.on('error', (error) => {
		logger.error?.(`[addon] error del servidor: ${error?.message ?? error}`);
	});

	return { app, server };
}

/**
 * Puerto dinámico compatible con Beamup y demás PaaS.
 *
 * @returns {number}
 */
function dynamicPort() {
	return Number(process.env.PORT) || 7000;
}

/* ---------------------------------------------------------------------- *
 * Proxy /proxy-stream
 * ---------------------------------------------------------------------- */

/**
 * Crea el handler Express del proxy de streams.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] Inactividad máxima con el upstream.
 * @param {string[]} [options.allowedHosts] Allowlist de hosts (sufijos válidos).
 * @param {boolean} [options.allowPrivateNetworks] Permitir IPs privadas (solo tests/dev).
 * @param {Pick<Console, 'warn' | 'info'>} [options.logger]
 * @returns {import('express').RequestHandler}
 */
export function createProxyStreamHandler(options = {}) {
	const logger = options.logger ?? console;
	const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
	const allowPrivateNetworks = options.allowPrivateNetworks === true;
	const timeoutMs = toPositiveNumber(options.timeoutMs, DEFAULT_PROXY_TIMEOUT_MS);
	const maxRedirects = Number.isInteger(options.maxRedirects)
		? options.maxRedirects
		: MAX_PROXY_REDIRECTS;

	return async function proxyStreamHandler(req, res) {
		const controller = new AbortController();
		let upstreamStream = null;

		const onClientClose = () => {
			if (res.writableEnded) return;
			upstreamStream?.destroy?.();
			controller.abort();
		};
		res.once('close', onClientClose);

		try {
			const target = parseProxyTarget(req);
			if (!target) {
				res.status(400).json({
					error: 'invalid_url',
					message: 'Parámetro `url` ausente o inválido (solo http/https).'
				});
				return;
			}

			await assertSafeTarget(target.url, { allowedHosts, allowPrivateNetworks });

			const upstream = await fetchUpstream(target.url, {
				headers: buildUpstreamHeaders(req, target),
				timeoutMs,
				maxRedirects,
				signal: controller.signal,
				allowedHosts,
				allowPrivateNetworks
			});

			upstreamStream = upstream.data;

			res.status(upstream.status);
			copyResponseHeaders(upstream.headers, res);
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

			if (
				req.method === 'HEAD' ||
				upstream.status === 204 ||
				upstream.status === 304 ||
				!upstreamStream
			) {
				upstreamStream?.destroy?.();
				res.end();
				return;
			}

			upstreamStream.on('error', (error) => {
				logger.warn?.(`[proxy] error transmitiendo ${target.url}: ${error?.message ?? error}`);
				if (!res.headersSent) {
					res.status(502).json({ error: 'upstream_error', message: 'Fallo al transmitir el stream.' });
				} else {
					res.destroy();
				}
			});

			upstreamStream.pipe(res);
		} catch (error) {
			if (controller.signal.aborted && res.writableEnded) return;

			const status = error instanceof ProxyTargetError ? error.statusCode : 502;
			const code = error?.code ?? 'proxy_error';

			logger.warn?.(`[proxy] ${req.method} ${req.path}: ${error?.message ?? error}`);

			if (res.headersSent) {
				res.destroy();
				return;
			}

			res.status(status).json({ error: code, message: error?.message ?? 'Error en el proxy.' });
		}
	};
}

/**
 * Valida un destino y resuelve su DNS para bloquear SSRF.
 *
 * @param {string} rawUrl
 * @param {{ allowedHosts?: string[], allowPrivateNetworks?: boolean }} [options]
 * @returns {Promise<URL>}
 * @throws {ProxyTargetError}
 */
export async function assertSafeTarget(rawUrl, options = {}) {
	const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
	const allowPrivateNetworks = options.allowPrivateNetworks === true;

	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new ProxyTargetError('URL inválida.', 400, 'invalid_url');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new ProxyTargetError('Solo se permiten URLs http/https.', 400, 'invalid_protocol');
	}

	if (url.username || url.password) {
		throw new ProxyTargetError('No se permiten credenciales en la URL.', 400, 'invalid_url');
	}

	const hostname = stripBrackets(url.hostname).toLowerCase();

	if (allowedHosts.length > 0 && !hostAllowed(hostname, allowedHosts)) {
		throw new ProxyTargetError(`Host no permitido: ${hostname}.`, 403, 'host_not_allowed');
	}

	if (!allowPrivateNetworks && isBlockedHostname(hostname)) {
		throw new ProxyTargetError(`Host bloqueado: ${hostname}.`, 403, 'forbidden_target');
	}

	if (net.isIP(hostname) && !allowPrivateNetworks && isPrivateAddress(hostname)) {
		throw new ProxyTargetError('Destino en red privada bloqueado.', 403, 'forbidden_target');
	}

	// Resuelve DNS para bloquear destinos internos aunque el hostname sea público.
	if (!net.isIP(hostname)) {
		let records;
		try {
			records = await dns.lookup(hostname, { all: true, verbatim: true });
		} catch {
			throw new ProxyTargetError(`No se pudo resolver ${hostname}.`, 502, 'dns_error');
		}

		if (!Array.isArray(records) || records.length === 0) {
			throw new ProxyTargetError(`No se pudo resolver ${hostname}.`, 502, 'dns_error');
		}

		if (!allowPrivateNetworks) {
			for (const record of records) {
				if (isPrivateAddress(record.address)) {
					throw new ProxyTargetError(
						`El destino ${hostname} resuelve a una red privada.`,
						403,
						'forbidden_target'
					);
				}
			}
		}
	}

	return url;
}

/**
 * Indica si una IP pertenece a rangos privados/reservados.
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
	if (typeof address !== 'string') return true;

	if (net.isIPv4(address)) {
		const [a, b, c] = address.split('.').map(Number);

		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true; // link-local / metadata cloud
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
		if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // reservadas
		if (a === 198 && b === 51 && c === 100) return true; // documentación
		if (a === 203 && b === 0 && c === 113) return true; // documentación
		if (a >= 224) return true; // multicast / reservado

		return false;
	}

	if (net.isIPv6(address)) {
		const normalized = address.toLowerCase().replace(/%.*$/, '');

		if (normalized === '::' || normalized === '::1') return true;

		// fe80::/10 (link-local)
		if (/^fe[89ab]/.test(normalized)) return true;
		// fc00::/7 (unique local)
		if (/^f[cd]/.test(normalized)) return true;

		if (normalized.startsWith('::ffff:')) {
			return isPrivateAddress(normalized.slice('::ffff:'.length));
		}

		return false;
	}

	// Cualquier formato desconocido se considera no seguro.
	return true;
}

/**
 * Construye una URL de proxy lista para usar en un stream.
 *
 * @param {string} baseUrl URL pública del addon.
 * @param {string} targetUrl URL a reproducir.
 * @param {{ referer?: string, userAgent?: string }} [options]
 * @returns {string}
 */
export function buildProxyStreamUrl(baseUrl, targetUrl, { referer, userAgent } = {}) {
	const params = new URLSearchParams({ url: targetUrl });
	if (referer) params.set('referer', referer);
	if (userAgent) params.set('ua', userAgent);

	return `${String(baseUrl).replace(/\/+$/, '')}/proxy-stream?${params.toString()}`;
}

/**
 * Extrae y valida los parámetros del proxy.
 *
 * @param {import('express').Request} req
 * @returns {{ url: string, referer: string|null, userAgent: string|null } | null}
 */
function parseProxyTarget(req) {
	const raw = req.query?.url ?? req.query?.u ?? req.query?.src;

	if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 4096) return null;

	let url;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	url.hash = '';

	const rawReferer = typeof req.query?.referer === 'string' ? req.query.referer : req.query?.ref;
	const rawUserAgent = typeof req.query?.ua === 'string' ? req.query.ua : null;

	return {
		url: url.toString(),
		referer: sanitizeReferer(rawReferer),
		userAgent: sanitizeUserAgent(rawUserAgent)
	};
}

/**
 * Sigue redirecciones manualmente para validar cada salto (anti-SSRF).
 *
 * @param {string} url
 * @param {Object} options
 * @param {Record<string, string>} options.headers
 * @param {number} options.timeoutMs
 * @param {number} options.maxRedirects
 * @param {AbortSignal} options.signal
 * @param {string[]} options.allowedHosts
 * @param {boolean} options.allowPrivateNetworks
 * @returns {Promise<any>} Respuesta de Axios en modo stream.
 */
async function fetchUpstream(url, options) {
	let current = url;

	for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
		const response = await axios.request({
			url: current,
			method: 'GET',
			responseType: 'stream',
			timeout: options.timeoutMs,
			maxRedirects: 0,
			validateStatus: () => true,
			decompress: false,
			headers: options.headers,
			signal: options.signal
		});

		if (isRedirect(response.status) && response.headers?.location) {
			response.data?.destroy?.();

			let next;
			try {
				next = new URL(response.headers.location, current);
			} catch {
				throw new ProxyTargetError('Redirección inválida.', 502, 'upstream_error');
			}

			next.hash = '';
			await assertSafeTarget(next.toString(), {
				allowedHosts: options.allowedHosts,
				allowPrivateNetworks: options.allowPrivateNetworks
			});

			current = next.toString();
			continue;
		}

		return response;
	}

	throw new ProxyTargetError('Demasiadas redirecciones.', 508, 'too_many_redirects');
}

/**
 * @param {any} headers
 * @param {import('express').Response} res
 */
function copyResponseHeaders(headers = {}, res) {
	for (const name of FORWARDED_RESPONSE_HEADERS) {
		const value = headers[name];
		if (value !== undefined && value !== null) res.setHeader(name, String(value));
	}
}

/**
 * @param {import('express').Request} req
 * @param {{ url: string, referer: string|null, userAgent: string|null }} target
 * @returns {Record<string, string>}
 */
function buildUpstreamHeaders(req, target) {
	const headers = {
		'User-Agent': target.userAgent ?? pickUserAgent(),
		Referer: target.referer ?? `${new URL(target.url).origin}/`,
		Accept: 'video/*,application/octet-stream,*/*;q=0.8',
		'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
		// Evita respuestas comprimidas que rompan el seek de los reproductores.
		'Accept-Encoding': 'identity'
	};

	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = req.headers?.[name];
		if (typeof value === 'string' && value.length > 0 && value.length <= 1024) {
			headers[name] = value;
		}
	}

	return headers;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function sanitizeReferer(value) {
	if (typeof value !== 'string' || value.length > 2048) return null;

	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		url.username = '';
		url.password = '';
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function sanitizeUserAgent(value) {
	if (typeof value !== 'string') return null;

	const ua = value.trim();
	if (ua.length < 10 || ua.length > 512) return null;
	if (!/^[\x20-\x7E]+$/.test(ua)) return null; // sin CRLF ni cabeceras inyectadas

	return ua;
}

/**
 * @returns {string}
 */
function pickUserAgent() {
	return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function isRedirect(status) {
	return [301, 302, 303, 307, 308].includes(status);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeAllowedHosts(value) {
	const list = Array.isArray(value)
		? value
		: typeof value === 'string'
			? value.split(',')
			: [];

	return [
		...new Set(
			list
				.map((entry) =>
					String(entry ?? '')
						.trim()
						.toLowerCase()
						.replace(/^https?:\/\//, '')
						.split('/')[0]
						.replace(/:\d+$/, '')
				)
				.filter(Boolean)
		)
	];
}

/**
 * @param {string} hostname
 * @param {string[]} allowedHosts
 * @returns {boolean}
 */
function hostAllowed(hostname, allowedHosts) {
	const host = stripBrackets(hostname).toLowerCase().replace(/\.$/, '');

	return allowedHosts.some((entry) => {
		const allowed = stripBrackets(entry).toLowerCase().replace(/\.$/, '');
		return host === allowed || host.endsWith(`.${allowed}`);
	});
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
	const host = stripBrackets(hostname).toLowerCase();

	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal') ||
		host.endsWith('.home.arpa')
	);
}

/**
 * @param {string} hostname
 * @returns {string}
 */
function stripBrackets(hostname) {
	return String(hostname ?? '').replace(/^\[|\]$/g, '');
}

/**
 * Resuelve la configuración del proxy desde opciones y entorno.
 *
 * @param {boolean | object} [option]
 * @returns {{ enabled: boolean, allowedHosts: string[], allowPrivateNetworks: boolean, timeoutMs: number }}
 */
function resolveProxyConfig(option) {
	const config = typeof option === 'object' && option !== null ? option : {};
	const enabled =
		typeof option === 'boolean'
			? option
			: (config.enabled ?? process.env.ENABLE_STREAM_PROXY !== 'false');

	return {
		enabled,
		allowedHosts: normalizeAllowedHosts(
			config.allowedHosts ?? process.env.PROXY_ALLOWED_HOSTS ?? []
		),
		allowPrivateNetworks:
			config.allowPrivateNetworks ?? process.env.PROXY_ALLOW_PRIVATE === 'true',
		timeoutMs: toPositiveNumber(config.timeoutMs ?? process.env.PROXY_TIMEOUT_MS, DEFAULT_PROXY_TIMEOUT_MS)
	};
}

/**
 * Error controlado del proxy (código HTTP + código lógico).
 */
class ProxyTargetError extends Error {
	/**
	 * @param {string} message
	 * @param {number} [statusCode=400]
	 * @param {string} [code='proxy_error']
	 */
	constructor(message, statusCode = 400, code = 'proxy_error') {
		super(message);
		this.name = 'ProxyTargetError';
		this.statusCode = statusCode;
		this.code = code;
	}
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveNumber(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

/* ---------------------------------------------------------------------- *
 * Utilidades HTTP
 * ---------------------------------------------------------------------- */

/** Cabeceras CORS: el cliente web de Stremio las exige. */
function corsMiddleware(req, res, next) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
	res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
	res.setHeader('Access-Control-Max-Age', '86400');

	if (req.method === 'OPTIONS') {
		res.sendStatus(204);
		return;
	}

	next();
}

/**
 * Parsea el segmento extra de Stremio (`search=one%20piece&skip=0`).
 * El router del SDK ya lo hace, se conserva como utilidad pública.
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
 * Página HTML mínima con el enlace de instalación y los endpoints disponibles.
 *
 * @param {any} manifest
 * @param {string} baseUrl
 * @param {{ proxy?: boolean }} [options]
 * @returns {string}
 */
function renderLanding(manifest, baseUrl, { proxy = false } = {}) {
	const installUrl = getInstallUrl(baseUrl);
	const endpointList = [
		'/manifest.json',
		'/catalog/:type/:id.json',
		'/meta/:type/:id.json',
		'/stream/:type/:id.json',
		'/health',
		...(proxy ? ['/proxy-stream?url=...'] : [])
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
