/**
 * Clase base para todos los scrapers del addon.
 *
 * Responsabilidades:
 *  1. Enviar siempre un User-Agent de navegador real (rotativo por petición).
 *  2. Resolver la lista de espejos de la fuente y aplicar failover automático
 *     cuando un dominio responde 404/5xx, agota el timeout o falla a nivel de red.
 *  3. Imponer un timeout estricto de 4000 ms por petición con Axios.
 *  4. No romper nunca la ejecución: ante cualquier fallo registra una advertencia
 *     y devuelve un resultado vacío (`null` por defecto, `[]` en scrapers de listas).
 *
 * @example
 * import { BaseScraper, REQUEST_TIMEOUT_MS } from './base.scraper.js';
 * import { getSource } from '../config/sources.js';
 *
 * export class JikanScraper extends BaseScraper {
 *   constructor() {
 *     super(getSource('jikan'));
 *   }
 *
 *   async scrape(animeId) {
 *     const data = await this.get(`anime/${animeId}/full`);
 *     return data?.data ?? this.emptyResult();
 *   }
 * }
 *
 * const scraper = new JikanScraper();
 * const anime = await scraper.safeScrape(1); // nunca lanza: null si todo falla
 */

import axios from 'axios';
import {
	DEFAULT_TIMEOUT_MS,
	MIRROR_COOLDOWN_MS,
	MIRROR_FAILURE_THRESHOLD,
	clampTimeout,
	getSource,
	normalizeSource,
	resolveMirrors
} from '../config/sources.js';

/** Timeout estricto por petición, en milisegundos. */
export const REQUEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/**
 * User-Agents de navegadores reales y actuales. Se elige uno al azar por
 * petición (o se fija uno con la opción `userAgent`) para reducir bloqueos.
 */
export const USER_AGENTS = Object.freeze([
	// Chrome 130 · Windows 11
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	// Chrome 130 · macOS
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	// Safari 17.6 · macOS
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
	// Firefox 132 · Windows 11
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
	// Edge 130 · Windows 11
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
	// Chrome 130 · Android
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
]);

/**
 * Estados HTTP que disparan failover: el espejo puede responder distinto.
 * Los 4xx "de cliente" (400, 401, 422) no se reintentan porque el problema
 * viaja en la petición, no en el dominio.
 */
export const FAILOVER_STATUS_CODES = Object.freeze([
	403, // bloqueo por WAF / geobloqueo
	404, // recurso ausente en este espejo
	408, // request timeout
	425, // too early
	429, // rate limit
	451, // bloqueo legal
	500,
	502,
	503,
	504
]);

/** Códigos de error de red/transporte que disparan failover. */
export const FAILOVER_ERROR_CODES = Object.freeze([
	'ECONNABORTED',
	'ETIMEDOUT',
	'ECONNRESET',
	'ECONNREFUSED',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EPIPE',
	'ERR_BAD_RESPONSE',
	'ERR_NETWORK',
	'ERR_CANCELED',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET'
]);

/** Firmas habituales de páginas de desafío/anti-bot (Cloudflare, DDoS-Guard). */
const CHALLENGE_MARKERS = Object.freeze([
	'just a moment...',
	'cf-browser-verification',
	'cf-challenge',
	'attention required! | cloudflare',
	'ddos protection by',
	'checking your browser before accessing'
]);

/** Cabeceras que imita un navegador de escritorio real. */
const BROWSER_HEADERS = Object.freeze({
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
	'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
	'Accept-Encoding': 'gzip, deflate, br',
	'Cache-Control': 'no-cache',
	Pragma: 'no-cache',
	Connection: 'keep-alive',
	'Upgrade-Insecure-Requests': '1',
	'Sec-Fetch-Dest': 'empty',
	'Sec-Fetch-Mode': 'cors',
	'Sec-Fetch-Site': 'same-origin'
});

export class BaseScraper {
	/**
	 * @param {import('../config/sources.js').SourceConfig | string | Partial<import('../config/sources.js').SourceConfig>} source
	 *   Fuente configurada (objeto), su id (`'jikan'`) o un objeto mínimo
	 *   `{ id, baseUrl, mirrors }`.
	 * @param {Object} [options]
	 * @param {number} [options.timeout]      Timeout por petición; se recorta a 4000 ms.
	 * @param {string} [options.userAgent]    UA fijo (por defecto, rotativo).
	 * @param {boolean} [options.rotateUserAgent=true]
	 * @param {number} [options.maxRedirects=3]
	 * @param {number} [options.cooldownMs]   Cuarentena de un espejo que falla.
	 * @param {number} [options.failureThreshold] Fallos consecutivos antes de la cuarentena.
	 * @param {Pick<Console, 'warn' | 'info' | 'debug' | 'error'>} [options.logger=console]
	 * @throws {TypeError} Si la fuente no declara `id` y al menos un dominio.
	 */
	constructor(source, options = {}) {
		if (!source) {
			throw new TypeError(
				'BaseScraper requiere una fuente: pasa un objeto de configuración o un id de src/config/sources.js.'
			);
		}

		const normalized = typeof source === 'string' ? getSource(source) : normalizeSource(source);

		if (!normalized?.id || normalized.mirrors.length === 0) {
			throw new TypeError(
				'BaseScraper requiere una fuente con `id` y al menos un `baseUrl` o espejo válido.'
			);
		}

		this.source = normalized;
		this.id = normalized.id;
		this.name = normalized.name;
		this.category = normalized.category;

		this.timeout = clampTimeout(options.timeout ?? normalized.timeout ?? REQUEST_TIMEOUT_MS);
		this.maxRedirects = Number.isFinite(Number(options.maxRedirects))
			? Number(options.maxRedirects)
			: 3;
		this.userAgent = options.userAgent ?? normalized.userAgent ?? null;
		this.rotateUserAgent = options.rotateUserAgent !== false;

		this.cooldownMs = Number(options.cooldownMs) || MIRROR_COOLDOWN_MS;
		this.failureThreshold = Number(options.failureThreshold) || MIRROR_FAILURE_THRESHOLD;

		this.logger = options.logger ?? console;

		/** Lista efectiva de espejos, en orden de intento. */
		this.mirrors = resolveMirrors(normalized);

		/** @type {Map<string, { failures: number, successes: number, lastError: string|null, cooldownUntil: number }>} */
		this.mirrorState = new Map();

		/** Contadores globales de la fuente (útiles para /health). */
		this.stats = { requests: 0, successes: 0, failures: 0, failovers: 0 };

		/**
		 * Instancia de Axios con timeout propio y `validateStatus` permisivo:
		 * así clasificamos los estados HTTP nosotros mismos y decidimos si
		 * corresponde failover.
		 */
		this.http = axios.create({
			timeout: this.timeout,
			maxRedirects: this.maxRedirects,
			decompress: true,
			validateStatus: () => true,
			transitional: { clarifyTimeoutError: true }
		});
	}

	/* ------------------------------------------------------------------ *
	 * API pública para las subclases
	 * ------------------------------------------------------------------ */

	/**
	 * Realiza una petición GET con failover de espejos.
	 *
	 * @param {string} path Ruta relativa al `baseUrl` (p. ej. `anime/1/full`).
	 * @param {Object} [options] Opciones de Axios + `signal`, `validate`, `allowEmpty`.
	 * @returns {Promise<any | null>} Datos de la respuesta o `null` si todo falla.
	 */
	async get(path, options = {}) {
		return this.fetch(path, { ...options, method: 'GET' });
	}

	/**
	 * Realiza una petición POST con failover de espejos.
	 *
	 * @param {string} path
	 * @param {any} [data]
	 * @param {Object} [options]
	 * @returns {Promise<any | null>}
	 */
	async post(path, data = null, options = {}) {
		return this.fetch(path, { ...options, method: 'POST', data });
	}

	/**
	 * Núcleo del failover: intenta cada espejo en orden hasta obtener una
	 * respuesta válida. Nunca lanza excepciones por fallos de red o HTTP.
	 *
	 * @param {string} path
	 * @param {Object} [options]
	 * @param {AbortSignal} [options.signal]   Cancelación externa (p. ej. request del cliente).
	 * @param {(response: { status: number, data: any, headers: object, mirror: string }) => boolean} [options.validate]
	 * @param {boolean} [options.allowEmpty]   Acepta cuerpos vacíos como válidos.
	 * @param {boolean} [options.ignoreCooldown] Ignora la cuarentena de espejos.
	 * @param {string[]} [options.mirrors]     Sobreescribe la lista de espejos.
	 * @returns {Promise<any | null>}
	 */
	async fetch(path, options = {}) {
		const mirrors = Array.isArray(options.mirrors) && options.mirrors.length > 0
			? options.mirrors
			: this.mirrors;

		if (mirrors.length === 0) {
			this.warn('no hay espejos configurados; se devuelve un resultado vacío.');
			return this.emptyResult();
		}

		const usable =
			options.ignoreCooldown === true
				? mirrors
				: mirrors.filter((mirror) => !this.isCoolingDown(mirror));
		// Si la cuarentena dejaría la lista vacía, se ignoran las marcas de tiempo.
		const attempts = usable.length > 0 ? usable : mirrors;
		const failures = [];

		for (let index = 0; index < attempts.length; index += 1) {
			const mirror = attempts[index];

			if (index > 0) this.stats.failovers += 1;

			try {
				const response = await this.executeRequest(mirror, path, options);
				this.stats.requests += 1;

				if (response.status >= 400) {
					const detail = `HTTP ${response.status} en ${mirror}`;
					this.recordFailure(mirror, detail);
					failures.push(detail);

					if (this.isFailoverStatus(response.status)) {
						if (index < attempts.length - 1) {
							this.warn(`${detail}. Probando el siguiente espejo...`);
							continue;
						}

						// Último espejo: se sale del bucle para registrar el resumen final.
						this.warn(`${detail}. No quedan más espejos.`);
						break;
					}

					this.warn(`${detail}. Estado no recuperable con otro espejo; se aborta.`);
					return this.emptyResult();
				}

				if (!this.isResponseValid(response, options)) {
					const detail = `respuesta inválida (posible bloqueo o cuerpo vacío) en ${mirror}`;
					this.recordFailure(mirror, detail);
					failures.push(detail);
					this.warn(`${detail}. Probando el siguiente espejo...`);
					continue;
				}

				this.recordSuccess(mirror);
				this.stats.successes += 1;

				if (index > 0) {
					this.warn(`recuperado usando el espejo de respaldo ${mirror}.`);
				}

				return response.data;
			} catch (error) {
				this.stats.requests += 1;
				this.stats.failures += 1;

				const detail = `fallo en ${mirror}: ${this.describeError(error)}`;
				this.recordFailure(mirror, detail);
				failures.push(detail);

				if (this.isFailoverError(error)) {
					this.warn(`${detail}. Probando el siguiente espejo...`);
					continue;
				}

				this.warn(`${detail}. Error no recuperable; se aborta la fuente.`);
				return this.emptyResult();
			}
		}

		this.warn(`todos los espejos fallaron para "${path}". ${failures.join(' | ')}`);
		return this.emptyResult();
	}

	/**
	 * Envuelve `scrape()` de las subclases para garantizar que una excepción
	 * fortuita no tumbe el addon: se registra y se devuelve resultado vacío.
	 *
	 * @param {...any} args Argumentos que recibe `scrape()`.
	 * @returns {Promise<any | null>}
	 */
	async safeScrape(...args) {
		try {
			const result = await this.scrape(...args);
			return result ?? this.emptyResult();
		} catch (error) {
			this.warn(`scrape() lanzó una excepción: ${this.describeError(error)}. Se devuelve un resultado vacío.`);
			return this.emptyResult();
		}
	}

	/**
	 * Punto de extensión que implementa cada scraper concreto.
	 * La implementación base no hace nada: devuelve un resultado vacío.
	 *
	 * @abstract
	 * @returns {Promise<any | null>}
	 */
	async scrape() {
		this.warn('scrape() no está implementado en esta fuente; se devuelve un resultado vacío.');
		return this.emptyResult();
	}

	/**
	 * Resultado vacío por defecto. Los scrapers que devuelven listas deben
	 * sobreescribirlo: `emptyResult() { return []; }`.
	 *
	 * @returns {null}
	 */
	emptyResult() {
		return null;
	}

	/* ------------------------------------------------------------------ *
	 * Construcción de peticiones
	 * ------------------------------------------------------------------ */

	/**
	 * Ejecuta una petición HTTP contra un espejo concreto, con timeout duro
	 * independiente del de Axios (watchdog con AbortController).
	 *
	 * @param {string} mirror
	 * @param {string} path
	 * @param {Object} options
	 * @returns {Promise<{ status: number, data: any, headers: Record<string, string>, url: string, mirror: string, durationMs: number }>}
	 */
	async executeRequest(mirror, path, options = {}) {
		const url = this.buildUrl(mirror, path);
		const controller = new AbortController();
		const externalSignal = options.signal;

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeout);

		const forwardAbort = () => controller.abort();
		if (externalSignal) {
			if (externalSignal.aborted) controller.abort();
			else externalSignal.addEventListener('abort', forwardAbort, { once: true });
		}

		const startedAt = Date.now();

		try {
			const response = await this.http.request({
				url,
				method: String(options.method ?? 'GET').toUpperCase(),
				headers: this.getHeaders(options.headers, mirror),
				params: options.params,
				data: options.data,
				responseType: options.responseType ?? 'json',
				maxRedirects: options.maxRedirects ?? this.maxRedirects,
				signal: controller.signal
			});

			return {
				status: response.status,
				data: response.data,
				headers: response.headers ?? {},
				url: response.request?.res?.responseUrl ?? url,
				mirror,
				durationMs: Date.now() - startedAt
			};
		} catch (error) {
			if (timedOut) {
				const timeoutError = new Error(
					`timeout de ${this.timeout} ms agotado en ${mirror}`
				);
				timeoutError.code = 'ETIMEDOUT';
				timeoutError.cause = error;
				throw timeoutError;
			}

			if (externalSignal?.aborted) {
				const aborted = new Error(`petición cancelada por el cliente (${mirror})`);
				aborted.code = 'ERR_CANCELED';
				aborted.cause = error;
				throw aborted;
			}

			throw error;
		} finally {
			clearTimeout(timer);
			externalSignal?.removeEventListener?.('abort', forwardAbort);
		}
	}

	/**
	 * Construye la URL final a partir del espejo y la ruta relativa.
	 * Si `path` ya es una URL absoluta se respeta tal cual.
	 *
	 * @param {string} mirror
	 * @param {string} path
	 * @returns {string}
	 */
	buildUrl(mirror, path = '') {
		const target = String(path ?? '');

		if (/^https?:\/\//i.test(target)) return target;

		const base = mirror.endsWith('/') ? mirror : `${mirror}/`;
		return new URL(target.replace(/^\/+/, ''), base).toString();
	}

	/**
	 * Cabeceras de la petición: UA de navegador real + cabeceras de la fuente.
	 *
	 * @param {Record<string, string>} [extra]
	 * @param {string | null} [mirror] Espejo actual (para `referer` con `{mirror}`).
	 * @returns {Record<string, string>}
	 */
	getHeaders(extra = {}, mirror = null) {
		const headers = {
			'User-Agent': this.pickUserAgent(),
			...BROWSER_HEADERS,
			...(this.source.headers ?? {}),
			...extra
		};

		if (this.source.referer) {
			headers.Referer = this.source.referer.replace('{mirror}', mirror ?? this.mirrors[0] ?? '');
		}

		return headers;
	}

	/**
	 * Devuelve el User-Agent a usar: uno fijo si se configuró, o uno aleatorio
	 * del pool de navegadores reales.
	 *
	 * @returns {string}
	 */
	pickUserAgent() {
		if (this.userAgent) return this.userAgent;
		if (!this.rotateUserAgent) return USER_AGENTS[0];
		return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
	}

	/* ------------------------------------------------------------------ *
	 * Clasificación y validación
	 * ------------------------------------------------------------------ */

	/**
	 * @param {number} status
	 * @returns {boolean}
	 */
	isFailoverStatus(status) {
		return FAILOVER_STATUS_CODES.includes(status);
	}

	/**
	 * @param {unknown} error
	 * @returns {boolean}
	 */
	isFailoverError(error) {
		return FAILOVER_ERROR_CODES.includes(/** @type {any} */ (error)?.code);
	}

	/**
	 * Valida que una respuesta 2xx sirva realmente: descarta cuerpos vacíos y
	 * páginas de desafío anti-bot (que suelen llegar con 200).
	 *
	 * @param {{ status: number, data: any }} response
	 * @param {Object} [options]
	 * @returns {boolean}
	 */
	isResponseValid(response, options = {}) {
		if (response.status < 200 || response.status >= 300) return false;
		if (options.allowEmpty) return true;
		if (response.data === undefined || response.data === null) return false;

		if (typeof response.data === 'string') {
			const text = response.data.trim();
			if (text.length === 0) return false;

			const sample = text.slice(0, 2048).toLowerCase();
			if (CHALLENGE_MARKERS.some((marker) => sample.includes(marker))) return false;
		}

		if (typeof options.validate === 'function') {
			return Boolean(options.validate(response));
		}

		return true;
	}

	/**
	 * Describe un error de forma legible para los logs.
	 *
	 * @param {any} error
	 * @returns {string}
	 */
	describeError(error) {
		if (!error) return 'error desconocido';

		const parts = [];
		const status = error.response?.status;
		const code = error.code;

		if (status) parts.push(`HTTP ${status}`);
		if (code) parts.push(code);
		parts.push(error.message ?? String(error));

		return parts.join(' · ');
	}

	/* ------------------------------------------------------------------ *
	 * Salud de los espejos (circuit breaker simple)
	 * ------------------------------------------------------------------ */

	/**
	 * @param {string} mirror
	 * @returns {boolean} `true` si está en cuarentena.
	 */
	isCoolingDown(mirror) {
		const state = this.mirrorState.get(mirror);
		return Boolean(state && state.cooldownUntil > Date.now());
	}

	/**
	 * @param {string} mirror
	 * @param {string} reason
	 */
	recordFailure(mirror, reason) {
		const current = this.mirrorState.get(mirror) ?? {
			failures: 0,
			successes: 0,
			lastError: null,
			cooldownUntil: 0
		};

		const failures = current.failures + 1;

		this.mirrorState.set(mirror, {
			...current,
			failures,
			lastError: reason,
			cooldownUntil:
				failures >= this.failureThreshold ? Date.now() + this.cooldownMs : current.cooldownUntil
		});
	}

	/**
	 * @param {string} mirror
	 */
	recordSuccess(mirror) {
		const current = this.mirrorState.get(mirror) ?? {
			failures: 0,
			successes: 0,
			lastError: null,
			cooldownUntil: 0
		};

		this.mirrorState.set(mirror, {
			...current,
			failures: 0,
			successes: current.successes + 1,
			lastError: null,
			cooldownUntil: 0
		});
	}

	/**
	 * Snapshot del estado de la fuente y de cada espejo (para `/health`).
	 *
	 * @returns {{ id: string, name: string, timeout: number, stats: object, mirrors: object[] }}
	 */
	health() {
		return {
			id: this.id,
			name: this.name,
			timeout: this.timeout,
			stats: { ...this.stats },
			mirrors: this.mirrors.map((mirror) => {
				const state = this.mirrorState.get(mirror);
				return {
					mirror,
					failures: state?.failures ?? 0,
					successes: state?.successes ?? 0,
					lastError: state?.lastError ?? null,
					coolingDown: this.isCoolingDown(mirror),
					cooldownUntil: state?.cooldownUntil ?? 0
				};
			})
		};
	}

	/* ------------------------------------------------------------------ *
	 * Logging con prefijo de fuente
	 * ------------------------------------------------------------------ */

	/** @param {string} message */
	warn(message) {
		this.logger?.warn?.(`[${this.id}] ${message}`);
	}

	/** @param {string} message */
	info(message) {
		this.logger?.info?.(`[${this.id}] ${message}`);
	}

	/** @param {string} message */
	debug(message) {
		this.logger?.debug?.(`[${this.id}] ${message}`);
	}
}

export default BaseScraper;
