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
// เพิ่ม Attack Cooldown (atkRate) เพื่อให้ Animation เล่นทัน
const SPECS = {
    sword: { hp: 40, dmg: 5, range: 50, speed: 2.5, size: 30, cost: 20, atkRate: 800 },
    bow:   { hp: 20, dmg: 4, range: 300, speed: 2.5, size: 30, cost: 40, atkRate: 1000 },
    tank:  { hp: 120, dmg: 2, range: 50, speed: 1.2, size: 36, cost: 70, atkRate: 1200 },
    mage:  { hp: 30, dmg: 10, range: 250, speed: 1.8, size: 30, cost: 100, atkRate: 1500 }
};

let rooms = {};

// --- GAME LOOP (20 FPS) ---
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.status === 'playing') {
            updateGame(room);
            io.to(roomId).emit('world_update', {
                b: room.bases,
                e: room.energies,
                u: room.units.map(u => ({
                    i: u.id, t: u.type, s: u.side, c: u.color,
                    x: Math.round(u.x), y: Math.round(u.y), h: u.hp,
                    act: u.action // ส่งสถานะ animation (walk/attack)
                })),
                fx: room.effects // ส่ง Effect ชั่วคราว (เช่น ดาเมจ, กระสุน)
            });
            room.effects = []; // เคลียร์ Effect หลังส่งแล้ว
        }
    }
}, 50);

function updateGame(room) {
    ['left', 'right'].forEach(side => {
        if (room.energies[side] < 200) room.energies[side] += 0.2;
    });

    // Bot Logic
    if (room.mode === 'bot' && room.energies.right > 40 && Math.random() < 0.03) {
        const types = ['sword', 'bow', 'tank', 'mage'];
        const type = types[Math.floor(Math.random() * types.length)];
        if (room.energies.right >= SPECS[type].cost) spawnUnit(room, 'right', type, '#ef4444');
    }

    const units = room.units;
    const now = Date.now();

    for (let i = units.length - 1; i >= 0; i--) {
        if (units[i].dead) units.splice(i, 1);
    }

    units.forEach(u => {
        u.action = 'idle'; // Default state
        
        let target = null;
        let minDist = 999;

        units.forEach(o => {
            if (o.side !== u.side && !o.dead) {
                const dist = Math.hypot(u.x - o.x, u.y - o.y);
                if (dist < u.range && dist < minDist) { minDist = dist; target = o; }
            }
        });

        let isAttacking = false;
        // Check Base Attack
        const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
        const distToBase = Math.abs(u.x - enemyBaseX);
        const canHitBase = (u.side === 'left' && u.x >= WORLD_W - 250) || (u.side === 'right' && u.x <= 250);

        if (canHitBase) {
            isAttacking = true;
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';
                const targetSide = u.side === 'left' ? 'right' : 'left';
                room.bases[targetSide] -= u.dmg;
                room.effects.push({ type: 'dmg', x: enemyBaseX, y: WORLD_H/2, val: u.dmg });
                if (room.bases[targetSide] <= 0) endGame(room, u.side);
            }
        } else if (target) {
            isAttacking = true;
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';
                target.hp -= u.dmg;
                // Add Damage Effect
                room.effects.push({ type: 'dmg', x: target.x, y: target.y, val: u.dmg });
                if (target.hp <= 0) target.dead = true;
            }
        }

        if (!isAttacking) {
            const dir = u.side === 'left' ? 1 : -1;
            u.x += dir * u.speed;
            u.action = 'walk';
            
            // เดินหลบกันนิดหน่อย
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
    for (let i = 0; i < 5; i++) { // ลดจำนวนต่อชุดเหลือ 5 เพื่อลดแลคบนมือถือ
        room.units.push({
            id: `${batchId}_${i}`,
            type, side, color,
            x: side === 'left' ? 120 : WORLD_W - 120,
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

// --- SOCKET ---
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
            effects: [],
            players: [{ id: socket.id, name: data.name, side: '', ready: false, color: '#3b82f6' }]
        };
        socket.join(roomId);
        
        if (data.mode === 'bot') {
            const r = rooms[roomId];
            r.players[0].side = 'left';
            r.players[0].ready = true;
            r.status = 'playing';
            socket.emit('room_created', { roomId });
            io.to(roomId).emit('update_lobby', r.players); // แจ้งเตือน Lobby
            io.to(roomId).emit('start_game', {}); // เริ่มเกมเลย
        } else {
            socket.emit('room_created', { roomId });
            updateLobby(roomId);
        }
    });

    socket.on('join_room', (data) => {
        // Trim เพื่อป้องกันวรรคเกิน
        const code = data.roomId.trim().toUpperCase();
        const r = rooms[code];
        
        if (r && r.status === 'waiting' && r.players.length < 2) {
            r.players.push({ id: socket.id, name: data.name, side: '', ready: false, color: '#ef4444' });
            socket.join(code);
            // แจ้ง Client ว่าเข้าสำเร็จ (สำคัญมาก!)
            socket.emit('join_success', { roomId: code });
            updateLobby(code);
        } else {
            socket.emit('error_msg', 'ห้องเต็ม, ไม่พบห้อง, หรือเกมเริ่มแล้ว');
        }
    });

    socket.on('select_side', (data) => {
        const r = rooms[data.roomId];
        if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        
        // เช็คว่าฝั่งนั้นว่างไหม
        const taken = r.players.some(pl => pl.side === data.side && pl.id !== socket.id);
        if(!taken && p) {
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
        // ง่ายๆ: ถ้าหลุดตอนเล่นอยู่ เกมจบเลย
        for (const rid in rooms) {
            const r = rooms[rid];
            if(r.players.some(p => p.id === socket.id)) {
                io.to(rid).emit('error_msg', 'คู่แข่งหลุดการเชื่อมต่อ');
                delete rooms[rid];
            }
        }
    });
});

function updateLobby(roomId) {
    if(rooms[roomId]) io.to(roomId).emit('update_lobby', rooms[roomId].players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));