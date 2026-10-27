// ============================================================
// server.js  ->  El "intermediario" entre la página web y n8n
// ============================================================
//
// Flujo completo:
//
//   Navegador  --(1)-->  Este servidor (Node)  --(2)-->  n8n (webhook)
//   Navegador  <--(4)--  Este servidor (Node)  <--(3)--  n8n ("HOLA SOY N8N")
//

// 1) Cargamos las librerías que necesitamos
const express = require('express');   // Express: facilita crear un servidor web
require('dotenv').config();           // dotenv: lee el archivo .env (configuración)

// 2) Creamos la aplicación y leemos la configuración
const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/hola';

// 3) Middlewares (pequeñas ayudas que se ejecutan antes de nuestras rutas)
app.use(express.json());              // Permite leer el JSON que llega en las peticiones
app.use(express.static('public'));    // Sirve la carpeta "public" (nuestra página web)

// 4) Ruta que recibe el mensaje desde la página y lo reenvía a n8n
app.post('/api/enviar', async (req, res) => {
  const { mensaje } = req.body;

  // Validamos que el usuario haya escrito algo
  if (!mensaje || !mensaje.trim()) {
    return res.status(400).json({ error: 'Escribe un mensaje antes de enviar.' });
  }

  try {
    // Hacemos una petición POST al webhook de n8n
    const respuestaN8n = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje }),
    });

    // Si n8n responde con un error (404, 500...), lo avisamos
    if (!respuestaN8n.ok) {
      const detalle = await respuestaN8n.text();
      console.error('n8n respondió con error:', respuestaN8n.status, detalle);
      return res.status(502).json({
        error: `n8n respondió con error ${respuestaN8n.status}. ` +
               'Revisa que el workflow esté activo y la URL sea correcta.',
      });
    }

    // Leemos la respuesta como texto (así sirve tanto si n8n manda texto como JSON)
    const texto = await respuestaN8n.text();
    res.json({ respuesta: texto });
  } catch (error) {
    // Aquí caemos si n8n no está encendido o la URL no existe
    console.error('No se pudo conectar con n8n:', error.message);
    res.status(500).json({
      error: 'No se pudo conectar con n8n. ¿Está encendido? Revisa la URL del .env',
    });
  }
});

// 5) Arrancamos el servidor
app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
  console.log(`Enviando mensajes a n8n en: ${N8N_WEBHOOK_URL}`);
});
