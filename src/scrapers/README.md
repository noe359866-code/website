# Scrapers por categoría

Cada categoría vive en su propia carpeta y expone una fábrica que devuelve
descriptores de scraper. El orquestador solo consulta los que coinciden con el
tipo de contenido de la petición.

```
src/scrapers/
├── base.scraper.js              # BaseScraper: UA, timeout, failover, circuit breaker
├── html.scraper.js              # Motor genérico Cheerio (búsqueda + ficha)
├── registry.js                  # Registro global y catálogo de categorías
├── index.js                     # Agrega las categorías y registra los scrapers
├── movies/
│   ├── index.js                 # createMovieScrapers()
│   └── archive-org.scraper.js   # Fuente legal de ejemplo (dominio público)
├── anime/index.js               # createAnimeScrapers()      -> []
├── doramas/index.js             # createDoramaScrapers()     -> []
├── telenovelas/index.js         # createTelenovelaScrapers() -> []
└── cartoons/index.js            # createCartoonScrapers()    -> []
```

`registerBuiltInScrapers()` se ejecuta al crear el addon (`createAddon()`), de
modo que `/health` y `/stream` ya ven los scrapers integrados.

## Fuente incluida

`movies/archive-org.scraper.js` consulta la API pública de Internet Archive y
solo devuelve archivos de vídeo públicos de la colección `feature_films`. No
extrae enlaces de reproductores de terceros. Es el patrón de referencia para
cualquier fuente nueva.

## Añadir una fuente autorizada

Solo deben integrarse fuentes propias, de dominio público o con licencia
explícita. Pasos:

1. Da de alta la fuente en `src/config/sources.js` con `baseUrl`, `mirrors`,
   `headers` y `enabled`. No hardcodees dominios en los scrapers.
2. Crea `mi-fuente.scraper.js` dentro de la categoría correspondiente.
3. Hereda de `BaseScraper` (o de `HtmlScraper` si el sitio es HTML) y devuelve
   streams de Stremio; cualquier fallo debe resolverse con `[]`.
4. Añade el descriptor a la fábrica de la categoría:

```js
import { HtmlScraper } from '../../html.scraper.js';
import { getSource } from '../../../config/sources.js';

const scraper = new HtmlScraper(getSource('mi_fuente'), {
  searchPath: (query) => `buscar?q=${encodeURIComponent(query)}`,
  selectors: {
    result: '.resultado',
    resultLink: 'a.titulo',
    resultTitle: '.titulo',
    media: 'video[src], video source[src], iframe[src]',
  },
  contentTypes: ['movie'],
});

export function createMovieScrapers() {
  return [
    { scraper, categories: ['movies'], contentTypes: ['movie'], priority: 100 },
  ];
}
```

## Contrato

- **Entrada**: `scrape(context)` con `searchTitles`, `titles` (`es`, `esLatam`,
  `original`, `english`), `imdbId`, `type`, `season` y `episode`.
- **Salida**: `Array<{ name, title, url? , externalUrl?, quality? }>`.
  `url` para archivos reproducibles (mp4, webm, m3u8…); `externalUrl` para
  embeds que Stremio deba abrir fuera.
- **Errores**: `BaseScraper` ya registra el fallo, prueba el siguiente espejo y
  devuelve `[]` si todos caen. Aun así, cada scraper envuelve su lógica en
  `try/catch` para no afectar a los demás.
- **URLs**: usa rutas relativas al pedir fichas para conservar el failover;
  resuelve las URLs finales contra `lastMirror` (el espejo que respondió).

## Pruebas

```bash
node /tmp/addon-test/scrapers.test.mjs   # fixtures locales, sin red
```

Las pruebas levantan servidores HTTP locales: nunca dependen de terceros.
