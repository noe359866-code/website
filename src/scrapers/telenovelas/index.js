/**
 * Scrapers de Telenovelas.
 *
 * Añade aquí únicamente fuentes sobre las que tengas derechos o que ofrezcan
 * licencias compatibles. Cada entrada debe ser un descriptor:
 *
 *   { scraper: new MiScraper(), categories: ['telenovelas'], contentTypes: ['series'], priority: 100 }
 *
 * El scraper debe heredar de BaseScraper (o implementar `scrape(context)`) y
 * devolver un array de streams de Stremio. Mientras la lista esté vacía, el
 * orquestador simplemente no consulta esta categoría.
 */

/** @returns {Array<{ scraper: object, categories: string[], contentTypes: string[], priority: number }>} */
export function createTelenovelaScrapers() {
	return [];
}

export default createTelenovelaScrapers;
