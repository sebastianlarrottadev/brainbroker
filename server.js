const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// Configuración optimizada para Render
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Render asigna el puerto automáticamente
const PORT = process.env.PORT || 3000;
const MAX_JUGADORES_POR_SALA = 4;

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, "public")));
app.use("/AR", express.static(path.join(__dirname, "AR")));

// Ruta principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Ruta para el lobby
app.get("/lobby", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "lobby.html"));
});

// Ruta de salud para Render (IMPORTANTE)
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "OK", 
    service: "Deceptive Game",
    timestamp: new Date().toISOString(),
    salas_activas: Object.keys(salas).length,
    jugadores_conectados: jugadoresConectados.size
  });
});

// Estructura mejorada
const salas = {};
const jugadoresConectados = new Map();

io.on("connection", (socket) => {
  console.log("🔗 Nuevo cliente conectado:", socket.id);

  // 🧩 REGISTRAR JUGADOR (usado por todas las páginas)
  socket.on("registrarJugador", ({ salaId, playerName, personaje, desdeLobby = false }) => {
    console.log(`📝 Registrando jugador: ${playerName} en sala: ${salaId}, desdeLobby: ${desdeLobby}`);
    
    if (!salas[salaId]) {
      // Si la sala no existe, crearla
      salas[salaId] = [];
    }

    // Buscar si el jugador ya existe en la sala
    let jugador = salas[salaId].find(j => j.name === playerName);
    
    if (jugador) {
      // Jugador existe, actualizar socket ID
      console.log(`🔄 Jugador existente ${playerName}, actualizando socket: ${jugador.id} -> ${socket.id}`);
      jugador.id = socket.id;
      jugador.socketId = socket.id;
      jugador.estaConectado = true;
    } else {
      // Nuevo jugador
      if (salas[salaId].length >= MAX_JUGADORES_POR_SALA) {
        socket.emit("error", `La sala ${salaId} está llena (máximo ${MAX_JUGADORES_POR_SALA} jugadores)`);
        return;
      }
      
      jugador = { 
        id: socket.id, 
        socketId: socket.id,
        name: playerName, 
        personaje: personaje || 'ps1.png', 
        salud: 100,
        salaId: salaId,
        estaConectado: true
      };
      salas[salaId].push(jugador);
      console.log(`👤 Nuevo jugador ${playerName} agregado a sala ${salaId}`);
    }

    jugadoresConectados.set(socket.id, { playerName, salaId });
    socket.join(salaId);

    // Solo emitir actualización si viene del lobby
    if (desdeLobby) {
      io.to(salaId).emit("actualizarLobby", salas[salaId]);
      console.log(`📢 Lobby actualizado para sala ${salaId}`);
    }

    socket.emit("registroExitoso", { 
      salaId, 
      salud: jugador.salud,
      jugadores: salas[salaId] 
    });
  });

  // ❤️ ACTUALIZAR SALUD (desde chance.html)
  socket.on("actualizarSalud", ({ playerName, delta }) => {
    console.log(`📊 Recibido actualizarSalud: ${playerName}, delta: ${delta}`);
    
    for (const salaId in salas) {
      const jugador = salas[salaId].find(j => j.name === playerName);
      if (jugador) {
        const saludAnterior = jugador.salud;
        jugador.salud = Math.max(0, Math.min(100, jugador.salud + delta));
        
        console.log(`💚 ${playerName}: ${saludAnterior} → ${jugador.salud} (${delta > 0 ? '+' : ''}${delta})`);
        
        // Actualizar a TODOS los jugadores en la sala
        io.to(salaId).emit("actualizarLobby", salas[salaId]);
        io.to(salaId).emit("actualizarSaludJugador", {
          playerName,
          nuevaSalud: jugador.salud,
          delta: delta
        });
        
        console.log(`📢 Notificando a ${salas[salaId].length} jugadores en sala ${salaId}`);
        break;
      }
    }
  });

  // 🔄 SOLICITAR ESTADO ACTUAL
  socket.on("obtenerEstadoLobby", ({ salaId }) => {
    if (salas[salaId]) {
      socket.emit("actualizarLobby", salas[salaId]);
      console.log(`📨 Estado enviado a ${socket.id} para sala ${salaId}`);
    }
  });

  // 🌐 NOTIFICAR NAVEGACIÓN
  socket.on("jugadorNavegando", ({ playerName, salaId, pagina }) => {
    console.log(`🌐 ${playerName} navegando a: ${pagina}`);
    // Marcar jugador como "en otra página" pero mantenerlo en la sala
    io.to(salaId).emit("mensajeSistema", `${playerName} está en ${pagina}`);
  });

  // ❌ DESCONEXIÓN - Manejo más tolerante
  socket.on("disconnect", (reason) => {
    console.log("🔌 Jugador desconectado:", socket.id, "Razón:", reason);
    
    const jugadorInfo = jugadoresConectados.get(socket.id);
    if (jugadorInfo) {
      const { playerName, salaId } = jugadorInfo;
      const sala = salas[salaId];
      
      if (sala) {
        const jugador = sala.find(j => j.id === socket.id);
        if (jugador) {
          // Solo marcar como desconectado, no eliminar inmediatamente
          jugador.estaConectado = false;
          console.log(`⏸️ ${playerName} marcado como desconectado (permanece en sala)`);
          
          // Esperar 30 segundos antes de eliminar (permite navegación entre páginas)
          setTimeout(() => {
            const salaActual = salas[salaId];
            if (salaActual) {
              const jugadorIndex = salaActual.findIndex(j => j.id === socket.id && !j.estaConectado);
              if (jugadorIndex !== -1) {
                const jugadorEliminado = salaActual[jugadorIndex];
                salaActual.splice(jugadorIndex, 1);
                jugadoresConectados.delete(socket.id);
                
                console.log(`🗑️ ${jugadorEliminado.name} eliminado de sala ${salaId} (timeout)`);
                
                if (salaActual.length === 0) {
                  delete salas[salaId];
                  console.log(`🚮 Sala ${salaId} eliminada (vacía)`);
                } else {
                  io.to(salaId).emit("actualizarLobby", salaActual);
                  io.to(salaId).emit("mensajeSistema", `${jugadorEliminado.name} abandonó la sala`);
                }
              }
            }
          }, 30000); // 30 segundos de gracia para navegar entre páginas
        }
      }
    }
  });
});

// 🚀 Iniciar servidor optimizado para Render
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Servidor Deceptive corriendo en puerto: ${PORT}`);
  console.log(`📍 Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`👥 Máximo de jugadores por sala: ${MAX_JUGADORES_POR_SALA}`);
  console.log(`🌐 URL: https://tu-app.onrender.com`);
});
