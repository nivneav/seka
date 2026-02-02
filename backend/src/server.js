const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const path = require('path');
const cors = require('cors');

// Importuri Interne
const db = require('./config/db');        
const authRoutes = require('./routes/auth'); 
const Room = require('./models/Room');    

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rute API
app.use('/api/auth', authRoutes);

// Stocare Mese în Memorie
const activeRooms = {}; 

// Funcție: Încărcare Mese din Baza de Date la Start
async function loadActiveTables(io) {
    try {
        const [rows] = await db.query("SELECT * FROM game_tables");
        rows.forEach(row => {
            // Cheia este ID-ul numeric, dar îl tratăm cu grijă la socket join
            activeRooms[row.id] = new Room(row.id, row.table_name, row.stake, io);
            console.log(`[LOBBY] Masa '${row.table_name}' (ID: ${row.id}) activă.`);
        });
    } catch (err) {
        console.error("Eroare DB (Mese):", err.message);
        // Fallback: Creăm o masă de test dacă DB e gol sau inaccesibil
        if (!activeRooms[1]) {
            activeRooms[1] = new Room(1, 'Masa Test (100)', 100, io);
        }
    }
}

async function start() {
    // Configurare Socket.IO
    let ioOptions = { 
        cors: { 
            origin: "*", 
            methods: ["GET", "POST"],
            credentials: true 
        },
        pingTimeout: 60000 
    };
    
    // Configurare Redis Adapter (Pentru Scalare)
    try {
        const pubClient = createClient({ url: 'redis://' + (process.env.REDIS_HOST || 'localhost') + ':6379' });
        const subClient = pubClient.duplicate();
        
        pubClient.on('error', (err) => console.error('Redis Pub Error:', err.message));
        subClient.on('error', (err) => console.error('Redis Sub Error:', err.message));

        await Promise.all([pubClient.connect(), subClient.connect()]);
        
        ioOptions.adapter = createAdapter(pubClient, subClient);
        console.log("✅ Redis Conectat");
    } catch (e) {
        console.log("⚠️ Fără Redis (Mod Local Single Instance)");
    }

    const io = new Server(server, ioOptions);

    // Încărcăm mesele
    await loadActiveTables(io);

    // --- LOGICA SOCKET.IO ---
    io.on('connection', (socket) => {
        console.log(`🔌 Client conectat: ${socket.id}`);

        // 1. LOBBY: Cere lista de mese
        socket.on('get_lobby_data', () => {
            const list = Object.values(activeRooms).map(r => ({
                id: r.id, 
                name: r.name, 
                stake: r.baseStake, 
                players: r.players.length, 
                maxPlayers: 7
            }));
            socket.emit('lobby_update', list);
        });

        // 2. LOBBY: Creare masă nouă
        socket.on('create_table', async (data) => {
            const { tableName, stake, ownerId } = data;
            try {
                // Salvăm în DB
                const [result] = await db.query("INSERT INTO game_tables (table_name, stake, owner_id) VALUES (?, ?, ?)", [tableName, stake, ownerId]);
                const newId = result.insertId;
                
                // Instanțiem camera în memorie
                const newRoom = new Room(newId, tableName, stake, io);
                activeRooms[newId] = newRoom;
                
                // Anunțăm toți clienții din lobby
                io.emit('table_created', { id: newId, name: tableName, stake: stake, players: 0, maxPlayers: 7 });
                socket.emit('create_success', { roomId: newId });
            } catch (err) {
                console.error(err);
                socket.emit('msg_error', 'Eroare creare masă.');
            }
        });

        // 3. GAME: Intrare în cameră (FIX CRITIC AICI)
        socket.on('join_room', async ({ roomId, username }) => {
            console.log(`[DEBUG] Join request: User=${username}, RoomID=${roomId}`);
            
            const room = activeRooms[roomId];
            
            if (!room) { 
                socket.emit('msg_error', 'Masa nu există sau a fost ștearsă.'); 
                return; 
            }

            // Forțăm ID-ul să fie string pentru Socket.io rooms
            const socketRoomId = String(roomId);
            socket.join(socketRoomId);
            socket.data.roomId = roomId; // Salvăm ID-ul pe socket pentru referințe viitoare

            // Adăugăm jucătorul în logica camerei
            const res = await room.addPlayer({ username }, socket.id);
            
            if (res.success) {
                console.log(`[SUCCESS] ${username} a intrat în masa ${roomId}`);
                
                // --- FIX: Trimitem starea jocului DIRECT către acest client ---
                // Astfel interfața se desenează imediat și nu rămâne pe "Connecting..."
                socket.emit('game_state', room.getPublicState());

                // Dacă e reconectare și are cărți, i le arătăm
                if (res.isReconnect && res.player.hand?.length > 0) {
                    socket.emit('your_cards', res.player.hand);
                }
                
                // Anunțăm lobby-ul că s-a schimbat nr de jucători
                io.emit('lobby_update_count', { roomId, count: room.players.length });
            } else {
                console.log(`[FAIL] Join respins: ${res.msg}`);
                socket.emit('msg_error', res.msg);
            }
        });

        // 4. GAME: Acțiuni jucător (Bet, Fold, etc.)
        socket.on('player_action', (data) => {
            const roomId = socket.data.roomId || data.roomId;
            const room = activeRooms[roomId];
            
            if (room) {
                // Normalizăm numele acțiunii
                let actionName = data.action || data.type;
                if(actionName) {
                    room.handleAction(socket.id, actionName.toUpperCase(), data);
                }
            }
        });

        // 5. CHAT SYSTEM (NOU)
        socket.on('send_chat', ({ roomId, message }) => {
            // Validări de bază
            if (!message || typeof message !== 'string' || message.trim().length === 0) return;
            
            const cleanMessage = message.trim().substring(0, 200); // Limită 200 caractere
            const room = activeRooms[roomId];

            if (room) {
                // Identificăm cine a trimis mesajul pe baza socket.id (Securitate)
                const player = room.players.find(p => p.socketId === socket.id);
                const senderName = player ? player.username : "Anonim";

                // Trimitem mesajul doar celor din acea cameră
                io.to(String(roomId)).emit('receive_chat', {
                    username: senderName,
                    text: cleanMessage,
                    isSystem: false
                });
            }
        });

        // 6. DISCONNECT
        socket.on('disconnect', () => {
            const roomId = socket.data.roomId;
            if (roomId && activeRooms[roomId]) {
                activeRooms[roomId].removePlayer(socket.id);
                // Actualizăm lobby-ul
                io.emit('lobby_update_count', { roomId, count: activeRooms[roomId].players.length });
            }
            console.log(`❌ Client deconectat: ${socket.id}`);
        });
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🚀 Server SEKA Online pe portul ${PORT}`));
}

start();