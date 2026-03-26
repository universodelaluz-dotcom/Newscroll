# NewsScroll Ticker

Barra de noticias lista para incrustar en OBS que combina varios RSS públicos y ofrece un ranking de “noticias calientes”.

## Arquitectura

- **Backend (Express + RSS Parser)**: consulta periódicamente una lista de fuentes (Reuters, El País, BBC Mundo e Infobae), normaliza los artículos y los ordena por puntaje de prioridad (recencia + palabras clave como “breaking”).
- **Cache propia**: los datos se refrescan cada minuto y se exponen en /api/news para minimizar el scraping en vivo.
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
- **Curación a demanda**: `POST /api/curate` extrae la página y devuelve un bloque `{ curated: {...} }`. Usa el formulario en la barra para pegar tantas URL como quieras; cada curación se muestra en el panel inferior (con urgencia y etiquetas) y se antepone al ticker principal para que veas la inteligencia editorial en vivo.
- **Integrar Grok**: si defines `GROK_API_KEY` en el entorno, `curatePage` llama además a Grok (`grok-4-1-fast`) para pedir un JSON con headline, summary, highlights, tags y urgencia. Esa inteligencia reemplaza el título/resumen automático y el ticker exhibe los titulares más cortos/destacados directamente en la barra.

## Próximos pasos sugeridos

1. Añadir un dashboard con filtros por fuente/categoría.
2. Integrar un LLM (Grok, GPT-5.4, etc.) que vuelva a sintetizar títulos antes del ticker.
3. Guardar historial en disco o base de datos y exponer endpoints para estadísticas y clips de noticias destacadas.
