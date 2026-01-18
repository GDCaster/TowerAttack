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
const SPECS = {
    sword: { hp: 30, dmg: 2, range: 40, speed: 2, size: 28, cost: 20 }, // speed ปรับให้ server tick
    bow:   { hp: 15, dmg: 3, range: 250, speed: 2, size: 28, cost: 40 },
    tank:  { hp: 80, dmg: 1, range: 40, speed: 1.2, size: 32, cost: 70 },
    mage:  { hp: 20, dmg: 5, range: 200, speed: 1.5, size: 28, cost: 100 }
};

let rooms = {};

// --- GAME LOOP (Server Tick: 20 times/sec) ---
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.status === 'playing') {
            updateGame(room);
            // ส่งข้อมูลบีบอัดให้ Client (เฉพาะสิ่งที่เปลี่ยน)
            io.to(roomId).emit('world_update', {
                b: room.bases,
                u: room.units.map(u => ({
                    i: u.id, t: u.type, s: u.side, x: Math.round(u.x), y: Math.round(u.y), h: u.hp, c: u.color
                })),
                e: room.energies // ส่ง Energy ของทั้งสองฝั่ง (Client จะเลือกดูเอง)
            });
        }
    }
}, 50); // 50ms = 20 FPS

function updateGame(room) {
    // 1. Regen Energy
    ['left', 'right'].forEach(side => {
        if (room.energies[side] < 200) room.energies[side] += 0.2; // เพิ่มทีละนิด
    });

    // 2. Bot Logic
    if (room.mode === 'bot') {
        const bot = room.players.find(p => p.side === 'right'); // Bot is Right
        if (bot && bot.isBot) {
            // Bot AI ง่ายๆ: สุ่มปล่อยของเมื่อ Energy ถึง
            if (room.energies.right > 40 && Math.random() < 0.05) {
                const types = ['sword', 'bow', 'tank', 'mage'];
                const type = types[Math.floor(Math.random() * types.length)];
                if (room.energies.right >= SPECS[type].cost) {
                    spawnUnit(room, 'right', type, '#3b82f6', true);
                }
            }
        }
    }

    // 3. Move & Combat
    const units = room.units;
    
    // ล้างศพ
    for (let i = units.length - 1; i >= 0; i--) {
        if (units[i].dead) units.splice(i, 1);
    }

    units.forEach(u => {
        let target = null;
        let minDist = 999;
        const now = Date.now();

        // หาเป้าหมาย
        units.forEach(o => {
            if (o.side !== u.side && !o.dead) {
                const dist = Math.hypot(u.x - o.x, u.y - o.y);
                if (dist < u.range && dist < minDist) { minDist = dist; target = o; }
            }
        });

        let isAttacking = false;

        // โจมตีฐาน
        const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
        const distToBase = Math.abs(u.x - enemyBaseX);
        
        if (!target && distToBase < u.range) {
            isAttacking = true;
            if (now - u.lastAttack > 1000) {
                u.lastAttack = now;
                const targetSide = u.side === 'left' ? 'right' : 'left';
                room.bases[targetSide] -= u.dmg;
                if (room.bases[targetSide] <= 0) endGame(room, u.side);
            }
        } 
        // โจมตียูนิต
        else if (target) {
            isAttacking = true;
            if (now - u.lastAttack > 1000) {
                u.lastAttack = now;
                target.hp -= u.dmg;
                if (target.hp <= 0) target.dead = true;
            }
        }

        // เดิน
        if (!isAttacking) {
            const dir = u.side === 'left' ? 1 : -1;
            u.x += dir * u.speed;
        }
    });
}

function spawnUnit(room, side, type, color, isBot = false) {
    if (room.energies[side] < SPECS[type].cost) return;
    
    room.energies[side] -= SPECS[type].cost;
    const batchId = Date.now() + Math.random();
    
    // Spawn 10 ตัว
    for (let i = 0; i < 10; i++) {
        room.units.push({
            id: `${batchId}_${i}`,
            type, side, color,
            x: side === 'left' ? 120 : WORLD_W - 120,
            y: (WORLD_H / 2) + (Math.random() * 200 - 100),
            hp: SPECS[type].hp,
            dmg: SPECS[type].dmg,
            range: SPECS[type].range,
            speed: SPECS[type].speed,
            lastAttack: 0,
            dead: false
        });
    }
}

function endGame(room, winnerSide) {
    room.status = 'finished';
    io.to(room.id).emit('game_over', { winner: winnerSide });
    // ลบห้องหลังจากจบ 10 วิ
    setTimeout(() => delete rooms[room.id], 10000);
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            players: [{ id: socket.id, name: data.name, side: 'left', ready: false, color: '#ef4444' }],
            mode: data.mode,
            status: 'waiting',
            bases: { left: 1000, right: 1000 },
            energies: { left: 0, right: 0 },
            units: []
        };
        
        // ถ้าเป็น Bot Mode ให้เพิ่ม Bot ทันที
        if (data.mode === 'bot') {
            rooms[roomId].players.push({ id: 'bot', name: 'Bot', side: 'right', ready: true, color: '#3b82f6', isBot: true });
            rooms[roomId].players[0].ready = true; // Auto ready host
            rooms[roomId].status = 'playing'; // Start immediately
            socket.join(roomId);
            socket.emit('room_created', { roomId, isHost: true });
            io.to(roomId).emit('start_game', { mode: 'bot' });
        } else {
            socket.join(roomId);
            socket.emit('room_created', { roomId, isHost: true });
        }
        updateLobby(roomId);
    });

    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        if (room && room.status === 'waiting') {
            room.players.push({ id: socket.id, name: data.name, side: 'right', ready: false, color: '#3b82f6' });
            socket.join(data.roomId);
            updateLobby(data.roomId);
        } else {
            socket.emit('error_msg', 'Room not found or full');
        }
    });

    socket.on('toggle_ready', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) p.ready = !p.ready;
        
        updateLobby(roomId);

        // Check Start
        if (room.players.length === 2 && room.players.every(pl => pl.ready)) {
            room.status = 'playing';
            io.to(roomId).emit('start_game', { mode: room.mode });
        }
    });

    socket.on('spawn_request', (data) => {
        const room = rooms[data.roomId];
        if (!room || room.status !== 'playing') return;
        
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) {
            spawnUnit(room, p.side, data.type, p.color);
        }
    });

    socket.on('disconnect', () => {
        // Handle disconnect logic (remove player, delete room if empty)
    });
});

function updateLobby(roomId) {
    if(rooms[roomId]) io.to(roomId).emit('update_lobby', rooms[roomId].players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));