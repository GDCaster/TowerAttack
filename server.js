const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// --- GAME CONFIG ---
const WORLD_W = 1600;
const WORLD_H = 900;
const MAX_ENERGY = 200;

const SPECS = {
    sword: { hp: 40, dmg: 5, range: 50, speed: 2.5, size: 30, cost: 20, atkRate: 800 },
    bow:   { hp: 20, dmg: 4, range: 300, speed: 2.5, size: 30, cost: 40, atkRate: 1000 },
    tank:  { hp: 120, dmg: 2, range: 50, speed: 1.2, size: 36, cost: 70, atkRate: 1200 },
    mage:  { hp: 30, dmg: 10, range: 250, speed: 1.8, size: 30, cost: 100, atkRate: 1500 }
};

const BOT_SETTINGS = {
    easy:   { regen: 0.1,  aggro: 0.02 }, // ขึ้นช้า, นานๆ ปล่อยที
    normal: { regen: 0.2,  aggro: 0.05 }, // เท่าคน
    hard:   { regen: 0.35, aggro: 0.1 }   // ขึ้นไว, ปล่อยรัว
};

let rooms = {};

// --- GAME LOOP (20 FPS) ---
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.status === 'playing') {
            updateGame(room);
            
            // ส่งข้อมูลให้ทุกคน (แยก Energy ของใครของมัน)
            room.players.forEach(player => {
                if(player.isBot) return;
                io.to(player.id).emit('world_update', {
                    b: room.bases,
                    myEng: Math.floor(player.energy), // ส่ง Energy เฉพาะตัว
                    u: room.units.map(u => ({
                        i: u.id, t: u.type, s: u.side, c: u.color,
                        x: Math.round(u.x), y: Math.round(u.y), h: u.hp,
                        act: u.action
                    })),
                    fx: room.effects
                });
            });
            room.effects = [];
        }
    }
}, 50);

function updateGame(room) {
    // 1. Regen Energy (ทุกคน รวมถึง Bot)
    room.players.forEach(p => {
        if (p.energy < MAX_ENERGY) {
            // ถ้าเป็น Bot ใช้ค่า Regen ตามระดับความยาก
            const rate = p.isBot ? BOT_SETTINGS[room.difficulty].regen : 0.2;
            p.energy += rate;
        }
        
        // 2. AI Logic (ถ้าเป็น Bot)
        if (p.isBot) runBotLogic(room, p);
    });

    // 3. Physics & Combat
    const units = room.units;
    const now = Date.now();

    for (let i = units.length - 1; i >= 0; i--) {
        if (units[i].dead) units.splice(i, 1);
    }

    units.forEach(u => {
        u.action = 'idle';
        let target = null;
        let minDist = 999;

        units.forEach(o => {
            if (o.side !== u.side && !o.dead) {
                const dist = Math.hypot(u.x - o.x, u.y - o.y);
                if (dist < u.range && dist < minDist) { minDist = dist; target = o; }
            }
        });

        const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
        const canHitBase = (u.side === 'left' && u.x >= WORLD_W - 250) || (u.side === 'right' && u.x <= 250);

        if (canHitBase) {
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';
                const targetSide = u.side === 'left' ? 'right' : 'left';
                room.bases[targetSide] -= u.dmg;
                room.effects.push({ type: 'dmg', x: enemyBaseX, y: WORLD_H/2, val: u.dmg });
                if (room.bases[targetSide] <= 0) endGame(room, u.side);
            }
        } else if (target) {
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';
                target.hp -= u.dmg;
                room.effects.push({ type: 'dmg', x: target.x, y: target.y, val: u.dmg });
                if (target.hp <= 0) target.dead = true;
            }
        } else {
            const dir = u.side === 'left' ? 1 : -1;
            u.x += dir * u.speed;
            u.action = 'walk';
            const mid = WORLD_H / 2;
            if (u.y < mid - 100) u.y += 0.5;
            if (u.y > mid + 100) u.y -= 0.5;
        }
    });
}

function runBotLogic(room, bot) {
    // สุ่มปล่อยตามความดุ (Aggro)
    if (Math.random() < BOT_SETTINGS[room.difficulty].aggro) {
        // AI จะพยายามแก้ทาง หรือสุ่มปล่อย
        const types = ['sword', 'bow', 'tank', 'mage'];
        
        // กรองตัวที่เงินพอ
        const affordable = types.filter(t => bot.energy >= SPECS[t].cost);
        
        if (affordable.length > 0) {
            // สุ่มเลือกตัวที่ซื้อไหว
            const type = affordable[Math.floor(Math.random() * affordable.length)];
            spawnUnit(room, bot, type);
        }
    }
}

function spawnUnit(room, player, type) {
    if (player.energy < SPECS[type].cost) return;
    
    player.energy -= SPECS[type].cost; // หัก Energy เจ้าของ
    const batchId = Date.now() + Math.random();
    
    for (let i = 0; i < 5; i++) {
        room.units.push({
            id: `${batchId}_${i}`,
            type, 
            side: player.side, 
            color: player.color,
            x: player.side === 'left' ? 120 : WORLD_W - 120,
            y: (WORLD_H / 2) + (Math.random() * 250 - 125),
            hp: SPECS[type].hp,
            dmg: SPECS[type].dmg,
            range: SPECS[type].range,
            speed: SPECS[type].speed,
            lastAttack: 0,
            dead: false,
            action: 'idle'
        });
    }
}

function endGame(room, winner) {
    room.status = 'finished';
    io.to(room.id).emit('game_over', { winner });
    setTimeout(() => { delete rooms[room.id]; }, 5000);
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
        const maxPlayers = data.mode === '2v2' ? 4 : 2;
        
        rooms[roomId] = {
            id: roomId,
            mode: data.mode,
            difficulty: data.difficulty || 'normal',
            maxPlayers: maxPlayers,
            status: 'waiting',
            bases: { left: 1000, right: 1000 },
            units: [],
            effects: [],
            players: [{ 
                id: socket.id, 
                name: data.name, 
                side: '', 
                ready: false, 
                color: '#3b82f6',
                energy: 0,
                isBot: false 
            }]
        };
        
        socket.join(roomId);
        
        // ถ้าเล่นกับบอท ให้สร้างบอทใส่ห้องทันที
        if (data.mode === 'bot') {
            const r = rooms[roomId];
            r.players[0].side = 'left';
            r.players[0].ready = true;
            // สร้าง Bot Player
            r.players.push({
                id: 'bot_1', name: 'AI Bot', side: 'right', ready: true, 
                color: '#ef4444', energy: 0, isBot: true
            });
            
            r.status = 'playing';
            socket.emit('room_created', { roomId });
            io.to(roomId).emit('start_game', { mode: 'bot' });
        } else {
            socket.emit('room_created', { roomId });
            updateLobby(roomId);
        }
    });

    socket.on('join_room', (data) => {
        const code = data.roomId.trim().toUpperCase();
        const r = rooms[code];
        
        if (r && r.status === 'waiting' && r.players.length < r.maxPlayers) {
            r.players.push({ 
                id: socket.id, 
                name: data.name, 
                side: '', 
                ready: false, 
                color: getRandomColor(),
                energy: 0,
                isBot: false
            });
            socket.join(code);
            socket.emit('join_success', { roomId: code });
            updateLobby(code);
        } else {
            socket.emit('error_msg', 'ห้องเต็มหรือเริ่มไปแล้ว');
        }
    });

    socket.on('select_side', (data) => {
        const r = rooms[data.roomId];
        if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        
        // 2v2: ฝั่งละ 2 คน / 1v1: ฝั่งละ 1 คน
        const limit = r.mode === '2v2' ? 2 : 1;
        const currentCount = r.players.filter(pl => pl.side === data.side && pl.id !== socket.id).length;
        
        if(currentCount < limit && p) {
            p.side = data.side;
            p.ready = false;
            updateLobby(data.roomId);
        }
    });

    socket.on('toggle_ready', (roomId) => {
        const r = rooms[roomId];
        if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p && p.side) p.ready = !p.ready;
        
        updateLobby(roomId);

        // เริ่มเกมเมื่อทุกคนพร้อม และมีคนอยู่ทั้ง 2 ฝั่ง
        const allReady = r.players.every(pl => pl.ready && pl.side);
        const hasLeft = r.players.some(pl => pl.side === 'left');
        const hasRight = r.players.some(pl => pl.side === 'right');
        
        if (r.players.length >= 2 && allReady && hasLeft && hasRight) {
            r.status = 'playing';
            io.to(roomId).emit('start_game', {});
        }
    });

    socket.on('spawn_request', (data) => {
        const r = rooms[data.roomId];
        if (r && r.status === 'playing') {
            const p = r.players.find(pl => pl.id === socket.id);
            if (p) spawnUnit(r, p, data.type);
        }
    });
    
    socket.on('disconnect', () => {
        for (const rid in rooms) {
            const r = rooms[rid];
            const idx = r.players.findIndex(p => p.id === socket.id);
            if(idx !== -1) {
                r.players.splice(idx, 1);
                if(r.players.length === 0 || r.status === 'playing') {
                    io.to(rid).emit('error_msg', 'ผู้เล่นหลุดการเชื่อมต่อ');
                    delete rooms[rid];
                } else {
                    updateLobby(rid);
                }
            }
        }
    });
});

function updateLobby(roomId) {
    if(rooms[roomId]) io.to(roomId).emit('update_lobby', rooms[roomId].players);
}

function getRandomColor() {
    const colors = ['#2ed573', '#eccc68', '#ff7f50', '#1e90ff', '#ff4757', '#a29bfe'];
    return colors[Math.floor(Math.random() * colors.length)];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));