# NewsScroll Ticker

Barra de noticias lista para incrustar en OBS que combina varios RSS públicos y ofrece un ranking de "noticias calientes".

## Arquitectura

- **Backend (Express + RSS Parser)**: consulta periódicamente una lista de fuentes (Reuters, El País, BBC Mundo e Infobae), normaliza los artículos y los ordena por puntaje de prioridad (recencia + palabras clave como "breaking").
- **Cache propia**: los datos se refrescan cada minuto y se exponen en `/api/news` para minimizar el scraping en vivo.
- **Frontend estático**: el scroll usa CSS `@keyframes` y reinicia la animación cada vez que llegan nuevas noticias; se puede usar como Browser Source en OBS.

## Cómo ejecutar

1. `npm install`
2. `npm start` (también puedes usar `PORT=8080 npm start` para otro puerto).
3. Abre `http://localhost:3000` para ver la barra en un navegador o apunta OBS al mismo URL como *Browser Source*.
4. Usa la zona de control (botones `+` y `-` junto al slider) para ajustar la velocidad del scroll entre 5 s (rápido) y 120 s (más pausado); el medidor indica cuántas noticias por minuto caben al ritmo actual y el scroll responde al instante.

## Personalización

- **Nuevo feed**: agrega una entrada a `FEEDS` en `server.js` con `url` y `label`.
- **Resumen ligero**: el backend corta el contenido a 220 caracteres y calcula un `score` por recencia y palabras clave. Para mejoras (sentiment, categorías), reemplaza `calculateScore`.
- **OBS**: ajusta ancho, transparencia o velocidad modificando los estilos en `public/index.html`. Cambia `setInterval` en el script si quieres refrescar más/menos seguido (recomendado 30–60 s).
- **Curación a demanda**: ahora existe `POST /api/curate` que acepta `{ "url": "https://..." }`, extrae título, descripciones y varios párrafos con `cheerio`, y responde con `{ curated: { title, summary, highlights, keywords } }`. Puedes usar ese endpoint o el formulario incorporado en el ticker para pedir un resumen instantáneo del sitio que el cliente pegue en vivo.
- **Integrar Grok**: si tienes una API key de xAI, guarda `GROK_API_KEY` en una variable de entorno y úsala dentro de `curatePage` para orquestar llamadas al Agent Tools API; la función ya cachea 20 URL para no repetir solicitudes.

## Próximos pasos sugeridos

1. Añadir un dashboard con filtros por fuente/categoría.
2. Integrar un LLM (Grok, GPT-5.4, etc.) que vuelva a sintetizar títulos antes del ticker.
3. Guardar historial en disco o base de datos y exponer endpoints para estadísticas y clips de noticias destacadas.
