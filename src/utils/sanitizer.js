/**
 * Utilidades de saneamiento de texto.
 *
 * `sanitizeForUrl()` convierte un título arbitrario en un slug seguro para URLs:
 *   "Ángel Beats!: The Movie" -> "angel-beats-the-movie"
 *
 * `normalizeTitle()` no genera slugs: produce una forma canónica para comparar
 * y deduplicar títulos ("Ángel  Beats!" y "angel beats" son el mismo).
 *
 * Ambas eliminan acentos (Unicode NFD + marcas diacríticas) y transliteran las
 * letras que NFD no descompone (ß, æ, ø, ł…).
 */

/** Letras que la normalización NFD no descompone y conviene transliterar. */
const SPECIAL_LETTERS = Object.freeze({
	ß: 'ss',
	æ: 'ae',
	œ: 'oe',
	ø: 'o',
	đ: 'd',
	ð: 'd',
	ł: 'l',
	þ: 'th',
	ħ: 'h',
	ı: 'i',
	ŋ: 'n',
	Æ: 'AE',
	Œ: 'OE',
	Ø: 'O',
	Đ: 'D',
	Ł: 'L',
	Þ: 'TH',
	ẞ: 'SS'
});

/** Marcas diacríticas combinantes que deja NFD (á -> a + U+0301). */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Comillas y apóstrofos tipográficos. */
const QUOTES = /['’‘`´"“”«»„]/g;

/** Caracteres especiales de RegExp (para escapar el separador). */
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Reemplaza letras especiales por su equivalente ASCII, conservando la caja.
 *
 * @param {string} value
 * @returns {string}
 */
function replaceSpecialLetters(value) {
	return value.replace(/[ßæœøđðłþħıŋÆŒØĐŁÞẞ]/g, (letter) => SPECIAL_LETTERS[letter] ?? letter);
}

/**
 * Elimina los acentos de una cadena sin cambiar su caja.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripAccents(value) {
	return replaceSpecialLetters(String(value ?? ''))
		.normalize('NFD')
		.replace(COMBINING_MARKS, '');
}

/**
 * Indica si un texto contiene solo caracteres ASCII imprimibles.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAsciiText(value) {
	return typeof value === 'string' && value.length > 0 && /^[\x20-\x7E]+$/.test(value);
}

/**
 * Convierte un texto en slug apto para URLs.
 *
 * - Elimina acentos y translitera letras especiales.
 * - Descarta comillas y apóstrofos ("Don't" -> "dont").
 * - Pasa a minúsculas.
 * - Reemplaza cualquier secuencia de caracteres no alfanuméricos por `-`.
 *
 * @param {unknown} value Texto a convertir.
 * @param {Object} [options]
 * @param {string} [options.separator='-'] Separador entre palabras.
 * @param {number} [options.maxLength=120] Longitud máxima del slug.
 * @param {boolean} [options.lowercase=true] Si es `false`, conserva mayúsculas.
 * @param {string} [options.fallback=''] Slug a devolver si el texto queda vacío.
 * @returns {string}
 *
 * @example
 * sanitizeForUrl('Shingeki no Kyojin: The Final Season');
 * // -> 'shingeki-no-kyojin-the-final-season'
 *
 * sanitizeForUrl('Ángel Beats!', { separator: '_' });
 * // -> 'angel_beats'
 */
export function slugify(value, options = {}) {
	const {
		separator: rawSeparator = '-',
		maxLength = 120,
		lowercase = true,
		fallback = ''
	} = options;

	// Un separador vacío o inválido generaría una RegExp rota: se usa '-'.
	const separator =
		typeof rawSeparator === 'string' && rawSeparator.length > 0 ? rawSeparator : '-';

	const empty = () => applyFallback(fallback, options);

	if (value === null || value === undefined) return empty();

	let text = replaceSpecialLetters(String(value))
		.normalize('NFD')
		.replace(COMBINING_MARKS, '')
		.replace(QUOTES, '');

	if (lowercase) text = text.toLowerCase();

	const escapedSeparator = separator.replace(REGEXP_SPECIALS, '\\$&');
	const collapse = new RegExp(`${escapedSeparator}{2,}`, 'g');
	const trimEdges = new RegExp(`^${escapedSeparator}+|${escapedSeparator}+$`, 'g');

	text = text
		.replace(/[^a-zA-Z0-9]+/g, separator)
		.replace(collapse, separator)
		.replace(trimEdges, '');

	const limit = Math.floor(Number(maxLength));
	if (Number.isFinite(limit) && limit > 0 && text.length > limit) {
		const cut = text.slice(0, limit);
		const lastSeparator = cut.lastIndexOf(separator);
		// Corta en el último separador para no partir una palabra por la mitad.
		const truncated = (lastSeparator > 0 ? cut.slice(0, lastSeparator) : cut).replace(trimEdges, '');
		text = truncated;
	}

	return text || empty();
}

/**
 * Alias explícito de `slugify()`: limpia una cadena para usarla en una URL.
 *
 * @param {unknown} value
 * @param {Parameters<typeof slugify>[1]} [options]
 * @returns {string}
 */
export function sanitizeForUrl(value, options) {
	return slugify(value, options);
}

/**
 * Normaliza un título para comparaciones y deduplicación.
 *
 * Devuelve minúsculas, sin acentos ni puntuación, con espacios simples.
 * No es apto como slug: conserva espacios.
 *
 * @param {unknown} value
 * @returns {string}
 *
 * @example
 * normalizeTitle('  Ángel   Beats! ') === normalizeTitle('angel beats'); // true
 */
export function normalizeTitle(value) {
	return stripAccents(value)
		.toLowerCase()
		.replace(QUOTES, '')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * @param {string} fallback
 * @param {Parameters<typeof slugify>[1]} options
 * @returns {string}
 */
function applyFallback(fallback, options) {
	if (!fallback) return '';
	return slugify(fallback, { ...options, fallback: '' });
}

export default {
	slugify,
	sanitizeForUrl,
	stripAccents,
	normalizeTitle,
	isAsciiText
};
