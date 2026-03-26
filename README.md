# NewsScroll Ticker

Barra de noticias lista para incrustar en OBS que combina varios RSS públicos y ofrece un ranking de “noticias calientes”.

## Arquitectura

- **Backend (Express + RSS Parser)**: consulta periódicamente una lista de fuentes (Reuters, El País, BBC Mundo e Infobae), normaliza los artículos y los ordena por un puntaje de prioridad (recencia + keywords como “breaking”).
- **Cache propia**: los datos se refrescan cada minuto y se exponen en `/api/news` para minimizar el scraping en vivo.
- **Frontend estático**: el scroll usa CSS `@keyframes` y vuelve a inicializar la animación cada vez que llegan nuevas noticias; se puede usar como Browser Source en OBS.

## Cómo ejecutar

1. `npm install`
2. `npm start` (también puedes usar `PORT=8080 npm start` para otro puerto).
3. Abre `http://localhost:3000` para ver la barra en un navegador o apunta OBS al mismo URL como *Browser Source*.
4. Usa la zona de control (botones `+` y `-` junto al slider) para ajustar la velocidad del scroll entre 12 s (muy rápido) y 80 s (más lento); el medidor indica cuántas noticias por minuto caben al ritmo actual.

## Personalización

- **Nuevo feed**: agrega una entrada a `FEEDS` en `server.js` con `url` y `label`.
- **Resumen ligero**: el backend corta el contenido a 220 caracteres y calcula un `score` por recencia y keywords. Para mejoras (sentiment, categorías), reemplaza `calculateScore`.
- **OBS**: ajusta ancho, transparencia o velocidad modificando los estilos en `public/index.html`. Cambia `setInterval` en el script si quieres refrescar más/menos seguido (recomendado 30–60 s).
- **Curación a demanda**: ahora existe `POST /api/curate` que acepta `{ "url": "https://..." }`, extrae título, descripciones y varios párrafos con `cheerio`, y responde con `{ curated: { title, summary, highlights, keywords } }`. Puedes usar ese endpoint para pedir un resumen instantáneo del sitio que el cliente pegue en un formulario.  
- **Integrar Grok**: si tienes una API key de xAI, guarda `GROK_API_KEY` con tu clave (no la compartas). Puedes modificar `curatePage` para llamar a Grok Agent Tools con el texto extraído, y reemplazar `summary`/`highlights` con la respuesta del modelo; la función ya cachea hasta 20 URL para evitar repetir llamadas.

## Próximos pasos sugeridos

1. Añadir un dashboard con filtros por fuente/categoría.
2. Integrar un LLM (Grok, GPT-5.4, etc.) que vuelva a sintetizar títulos antes del ticker.
3. Guardar historial en disco o BD y exponer endpoints para estadísticas y clips de noticias destacadas.
