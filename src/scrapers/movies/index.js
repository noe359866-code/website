/**
 * Scrapers de Películas y Series.
 *
 * Solo se registran fuentes legales: dominio público, catálogos con licencia o
 * proveedores propios. `ArchiveOrgScraper` es el ejemplo funcional; para añadir
 * otra fuente autorizada, crea su archivo en esta carpeta y súmalo a la lista.
 */

import { ArchiveOrgScraper } from './archive-org.scraper.js';

/**
 * @returns {Array<{ scraper: object, categories: string[], contentTypes: string[], priority: number }>}
 */
export function createMovieScrapers() {
	return [
		{
			scraper: new ArchiveOrgScraper(),
			categories: ['movies'],
			contentTypes: ['movie'],
			priority: 50
		}
	];
}

export { ArchiveOrgScraper };

export default createMovieScrapers;
