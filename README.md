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
4. La sección inferior de la barra expone un control de velocidad: mueve el slider para alargar o acortar la animación y ver el medidor de “noticias por minuto” en tiempo real.

## Personalización

- **Nuevo feed**: agrega una entrada a `FEEDS` en `server.js` con `url` y `label`.
- **Resumen ligero**: el backend corta el contenido a 220 caracteres y calcula un `score` por recencia y keywords. Para mejoras (sentiment, categorías), reemplaza `calculateScore`.
- **OBS**: ajusta ancho, transparencia o velocidad modificando los estilos en `public/index.html`. Cambia `setInterval` en el script si quieres refrescar más/menos seguido (recomendado 30–60 s).

## Próximos pasos sugeridos

1. Añadir un dashboard con filtros por fuente/categoría.
2. Integrar un LLM (Grok, GPT-5.4, etc.) que vuelva a sintetizar títulos antes del ticker.
3. Guardar historial en disco o BD y exponer endpoints para estadísticas y clips de noticias destacadas.
