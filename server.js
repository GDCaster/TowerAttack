const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// --- GAME CONFIG (ก๊อปมาจากโค้ดคุณ) ---
const WORLD_W = 1600;
const WORLD_H = 900;
const SPECS = {
    sword: { hp: 30, dmg: 2, range: 40, speed: 3, size: 28, cost: 20 }, // ปรับ Speed ให้เหมาะกับ Server tick
    bow:   { hp: 15, dmg: 3, range: 250, speed: 3, size: 28, cost: 40 },
    tank:  { hp: 80, dmg: 1, range: 40, speed: 1.5, size: 32, cost: 70 },
    mage:  { hp: 20, dmg: 5, range: 200, speed: 2, size: 28, cost: 100 }
};

let rooms = {};

// --- SERVER LOOP (ทำงาน 20 ครั้งต่อวินาที) ---
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.status === 'playing') {
            updateGame(room);
            
            // ส่งข้อมูลกลับไปหาผู้เล่น
            io.to(roomId).emit('world_update', {
                b: room.bases, // เลือดฐาน
                e: room.energies, // Energy
                u: room.units.map(u => ({ // ยูนิต (ส่งแค่ที่จำเป็นเพื่อประหยัดเน็ต)
                    i: u.id, t: u.type, s: u.side, c: u.color,
                    x: Math.round(u.x), y: Math.round(u.y), h: u.hp
                }))
            });
        }
    }
}, 50);

function updateGame(room) {
    // 1. เพิ่ม Energy อัตโนมัติ
    ['left', 'right'].forEach(side => {
        if (room.energies[side] < 200) room.energies[side] += 0.2;
    });

    // 2. Logic บอท (ถ้ามี)
    if (room.mode === 'bot') {
        if (room.energies.right > 50 && Math.random() < 0.03) {
            const types = ['sword', 'bow', 'tank', 'mage'];
            const type = types[Math.floor(Math.random() * types.length)];
            if (room.energies.right >= SPECS[type].cost) {
                spawnUnit(room, 'right', type, '#3b82f6'); // บอทสีฟ้า
            }
        }
    }

    // 3. คำนวณ Physics (เดิน/ตี)
    const units = room.units;
    const now = Date.now();

    // ลบศพ
    for (let i = units.length - 1; i >= 0; i--) {
        if (units[i].dead) units.splice(i, 1);
    }

    units.forEach(u => {
        // หาเป้าหมาย
        let target = null;
        let minDist = 999;

        units.forEach(o => {
            if (o.side !== u.side && !o.dead) {
                const dist = Math.hypot(u.x - o.x, u.y - o.y);
                if (dist < u.range && dist < minDist) { minDist = dist; target = o; }
            }
        });

        // เช็คการตีฐาน
        let isAttacking = false;
        let attackingBase = false;

        if (u.side === 'left') {
            if (u.x >= WORLD_W - 250) attackingBase = true; // ถึงหน้าฐานขวา
        } else {
            if (u.x <= 250) attackingBase = true; // ถึงหน้าฐานซ้าย
        }

        if (attackingBase) {
            isAttacking = true;
            if (now - u.lastAttack > 1000) { // ตีทุก 1 วิ
                u.lastAttack = now;
                const targetSide = u.side === 'left' ? 'right' : 'left';
                room.bases[targetSide] -= u.dmg;
                if (room.bases[targetSide] <= 0) endGame(room, u.side);
            }
        } else if (target) {
            isAttacking = true;
            if (now - u.lastAttack > 1000) {
                u.lastAttack = now;
                target.hp -= u.dmg;
                if (target.hp <= 0) target.dead = true;
            }
        }

        // เดิน (ถ้าไม่ได้ตี)
        if (!isAttacking) {
            const dir = u.side === 'left' ? 1 : -1;
            u.x += dir * u.speed;
            
            // Logic เดินหลบกันเอง (Boid separation) แบบง่าย
            const mid = WORLD_H / 2;
            if (u.y < mid - 100) u.y += 0.5;
            if (u.y > mid + 100) u.y -= 0.5;
        }
    });
}

function spawnUnit(room, side, type, color) {
    if (room.energies[side] < SPECS[type].cost) return;

    room.energies[side] -= SPECS[type].cost;
    const batchId = Date.now() + Math.random();

    // Spawn 10 ตัว ตามต้นฉบับ
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

function endGame(room, winner) {
    room.status = 'finished';
    io.to(room.id).emit('game_over', { winner });
    // ลบห้องทิ้งหลังจบเกม 10 วินาที
    setTimeout(() => { delete rooms[room.id]; }, 10000);
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            mode: data.mode,
            status: 'waiting',
            bases: { left: 1000, right: 1000 },
            energies: { left: 0, right: 0 },
            units: [],
            players: [{ id: socket.id, name: data.name, side: '', ready: false, color: '#ef4444' }]
        };
        socket.join(roomId);
        
        if (data.mode === 'bot') {
            const r = rooms[roomId];
            r.players[0].side = 'left';
            r.players[0].ready = true;
            r.status = 'playing';
            socket.emit('room_created', { roomId });
            io.to(roomId).emit('update_lobby', r.players);
            io.to(roomId).emit('start_game', {});
        } else {
            socket.emit('room_created', { roomId });
            updateLobby(roomId);
        }
    });

    socket.on('join_room', (data) => {
        const r = rooms[data.roomId];
        if (r && r.status === 'waiting' && r.players.length < 2) {
            r.players.push({ id: socket.id, name: data.name, side: '', ready: false, color: '#3b82f6' });
            socket.join(data.roomId);
            updateLobby(data.roomId);
        } else {
            socket.emit('error_msg', 'เข้าไม่ได้');
        }
    });

    socket.on('select_side', (data) => {
        const r = rooms[data.roomId];
        if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) { p.side = data.side; p.ready = false; }
        updateLobby(data.roomId);
    });

    socket.on('select_color', (data) => {
        const r = rooms[data.roomId];
        if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) { p.color = data.color; }
        updateLobby(data.roomId);
    });

    socket.on('toggle_ready', (roomId) => {
        const r = rooms[roomId];
        if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p && p.side) p.ready = !p.ready;
        
        updateLobby(roomId);

        // เช็คเริ่มเกม
        if (r.players.length === 2 && r.players.every(pl => pl.ready && pl.side)) {
            r.status = 'playing';
            io.to(roomId).emit('start_game', {});
        }
    });

    socket.on('spawn_request', (data) => {
        const r = rooms[data.roomId];
        if (r && r.status === 'playing') {
            const p = r.players.find(pl => pl.id === socket.id);
            if (p) spawnUnit(r, p.side, data.type, p.color);
        }
    });
    
    socket.on('disconnect', () => {
        // Logic ลบคนเมื่อหลุด (ละไว้เพื่อให้โค้ดสั้นลง)
    });
});

function updateLobby(roomId) {
    if(rooms[roomId]) io.to(roomId).emit('update_lobby', rooms[roomId].players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));