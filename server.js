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
    sword:    { hp: 45,  dmg: 5,  range: 50,  speed: 2.5, size: 30, cost: 20, atkRate: 800 },
    bow:      { hp: 25,  dmg: 4,  range: 300, speed: 2.5, size: 30, cost: 50, atkRate: 1200 },
    tank:     { hp: 140, dmg: 3,  range: 50,  speed: 1.2, size: 36, cost: 70, atkRate: 1200 },
    mage:     { hp: 30,  dmg: 12, range: 250, speed: 1.8, size: 30, cost: 100, atkRate: 1500, type:'aoe', radius: 60 },
    assassin: { hp: 30,  dmg: 10, range: 40,  speed: 4.5, size: 25, cost: 50, atkRate: 500, special: 'jump' },
    cannon:   { hp: 70,  dmg: 25, range: 450, speed: 1.5, size: 40, cost: 175, atkRate: 2500, type:'aoe', radius: 100 }
};

const BOT_SETTINGS = {
    easy:   { regen: 0.1,  aggro: 0.02 },
    normal: { regen: 0.2,  aggro: 0.05 },
    hard:   { regen: 0.35, aggro: 0.12 }
};

const COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#3742fa', 
    '#2f3542', '#8e44ad', '#e84393', '#00d2d3', '#fff200'
];

let rooms = {};
let matchQueue = []; // [NEW] คิวสำหรับคนหาห้อง

// ... (GAME LOOP คงเดิม ไม่ต้องแก้) ...
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.players.length === 0) {
            delete rooms[roomId];
            continue;
        }
        if (room.status === 'playing') {
            updateGame(room);
            const packet = {
                b: room.bases,
                u: room.units.map(u => ({
                    i: u.id, t: u.type, s: u.side, c: u.color,
                    x: Math.round(u.x), y: Math.round(u.y), h: u.hp,
                    n: u.owner,
                    act: u.action
                })),
                proj: room.projectiles.map(p => ({
                    x: Math.round(p.x), y: Math.round(p.y), t: p.type
                })),
                fx: room.effects
            };
            room.players.forEach(player => {
                if(player.isBot) return;
                packet.myEng = Math.floor(player.energy);
                io.to(player.id).emit('world_update', packet);
            });
            room.effects = [];
        }
    }
}, 50);
// ... (ฟังก์ชัน updateGame, spawnUnit, ฯลฯ คงเดิม) ...
function updateGame(room) { /* Code เดิม */ 
    const now = Date.now();
    room.players.forEach(p => {
        if (p.energy < MAX_ENERGY) {
            const rate = p.isBot ? BOT_SETTINGS[room.difficulty].regen : 0.2;
            p.energy += rate;
        }
        if (p.isBot) runBotLogic(room, p);
    });
    for (let i = room.units.length - 1; i >= 0; i--) {
        if (room.units[i].dead) room.units.splice(i, 1);
    }
    room.units.forEach(u => {
        u.action = 'idle';
        let target = null;
        let minDist = 999;
        room.units.forEach(o => {
            if (o.side !== u.side && !o.dead) {
                const dist = Math.hypot(u.x - o.x, u.y - o.y);
                if (dist < minDist) { minDist = dist; target = o; }
            }
        });
        if (u.type === 'assassin' && target && !u.hasJumped && minDist < 350) {
            if (['bow','mage','cannon'].includes(target.type)) {
                const offset = u.side === 'left' ? 40 : -40;
                u.x = target.x + offset;
                u.y = target.y;
                u.hasJumped = true;
                room.effects.push({ type: 'warp', x: u.x, y: u.y });
            }
        }
        const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
        const distToBase = Math.abs(u.x - enemyBaseX);
        const canHitBase = distToBase <= SPECS[u.type].range;
        
        if (canHitBase) {
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';
                const targetSide = u.side === 'left' ? 'right' : 'left';
                room.bases[targetSide] -= u.dmg;
                room.effects.push({ type: 'dmg', x: enemyBaseX, y: WORLD_H/2, val: u.dmg });
                if (room.bases[targetSide] <= 0) endGame(room, u.side);
            }
        } else if (target && minDist <= SPECS[u.type].range) {
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';
                if (u.type === 'mage' || u.type === 'cannon') {
                    spawnProjectile(room, u, target);
                } else {
                    target.hp -= u.dmg;
                    room.effects.push({ type: 'dmg', x: target.x, y: target.y, val: u.dmg });
                    if (target.hp <= 0) target.dead = true;
                }
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
    updateProjectiles(room);
}
function spawnProjectile(room, owner, target) {
    room.projectiles.push({
        x: owner.x, y: owner.y, tx: target.x, ty: target.y,
        speed: owner.type === 'cannon' ? 14 : 10,
        dmg: SPECS[owner.type].dmg, radius: SPECS[owner.type].radius,
        type: owner.type, side: owner.side
    });
}
function updateProjectiles(room) {
    for (let i = room.projectiles.length - 1; i >= 0; i--) {
        const p = room.projectiles[i];
        const dx = p.tx - p.x;
        const dy = p.ty - p.y;
        const dist = Math.hypot(dx, dy);

        if (dist < p.speed) {
            room.units.forEach(u => {
                if (u.side !== p.side && !u.dead) {
                    const d = Math.hypot(u.x - p.tx, u.y - p.ty);
                    if (d <= p.radius) {
                        u.hp -= p.dmg;
                        room.effects.push({ type: 'dmg', x: u.x, y: u.y, val: p.dmg });
                        if (u.hp <= 0) u.dead = true;
                    }
                }
            });
            room.effects.push({ type: 'aoe', x: p.tx, y: p.ty, r: p.radius, t: p.type });
            room.projectiles.splice(i, 1);
        } else {
            const angle = Math.atan2(dy, dx);
            p.x += Math.cos(angle) * p.speed;
            p.y += Math.sin(angle) * p.speed;
        }
    }
}
function runBotLogic(room, bot) {
    if (Math.random() < BOT_SETTINGS[room.difficulty].aggro) {
        const types = Object.keys(SPECS);
        const affordable = types.filter(t => bot.energy >= SPECS[t].cost);
        if (affordable.length > 0) {
            spawnUnit(room, bot, affordable[Math.floor(Math.random() * affordable.length)]);
        }
    }
}
function spawnUnit(room, player, type) {
    if (player.energy < SPECS[type].cost) return;
    player.energy -= SPECS[type].cost;
    const batchId = Date.now() + Math.random();
    for (let i = 0; i < 5; i++) {
        room.units.push({
            id: `${batchId}_${i}`,
            type, side: player.side, color: player.color, owner: player.name,
            x: player.side === 'left' ? 120 : WORLD_W - 120,
            y: (WORLD_H / 2) + (Math.random() * 200 - 100),
            hp: SPECS[type].hp, dmg: SPECS[type].dmg,
            range: SPECS[type].range, speed: SPECS[type].speed,
            lastAttack: 0, dead: false, action: 'idle', hasJumped: false
        });
    }
}
function endGame(room, winner) {
    room.status = 'finished';
    io.to(room.id).emit('game_over', { winner });
    setTimeout(() => { delete rooms[room.id]; }, 3000);
}

// [NEW] ฟังก์ชันเช็คคิวและจับคู่
function checkMatchQueue() {
    // ต้องมีอย่างน้อย 2 คนเพื่อเริ่มเกม
    if (matchQueue.length >= 2) {
        // ดึง 2 คนแรกออกจากคิว
        const p1 = matchQueue.shift();
        const p2 = matchQueue.shift();

        const roomId = "AUTO_" + Math.random().toString(36).substr(2, 5).toUpperCase();
        
        // สร้างห้อง
        rooms[roomId] = {
            id: roomId, mode: '1v1', difficulty: 'normal',
            maxPlayers: 2, status: 'waiting', bases: { left: 1000, right: 1000 },
            units: [], projectiles: [], effects: [],
            players: []
        };

        const r = rooms[roomId];

        // ใส่ Player 1 (Left)
        r.players.push({ 
            id: p1.id, name: p1.name, side: 'left', ready: true, 
            color: COLORS[0], energy: 0, isBot: false 
        });

        // ใส่ Player 2 (Right)
        r.players.push({ 
            id: p2.id, name: p2.name, side: 'right', ready: true, 
            color: COLORS[1], energy: 0, isBot: false 
        });

        // ส่งทั้งคู่เข้าห้องและเริ่มเกมทันที
        const p1Socket = io.sockets.sockets.get(p1.id);
        const p2Socket = io.sockets.sockets.get(p2.id);

        if (p1Socket) { p1Socket.join(roomId); p1Socket.emit('join_success', { roomId }); }
        if (p2Socket) { p2Socket.join(roomId); p2Socket.emit('join_success', { roomId }); }
        
        updateLobby(roomId);
        
        // เริ่มเกมอัตโนมัติ
        r.status = 'playing';
        io.to(roomId).emit('start_game', { players: r.players });
    }
}

io.on('connection', (socket) => {
    // ... (create_room, join_room, etc. คงเดิม) ...
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
        const maxPlayers = data.mode === '2v2' ? 4 : 2;
        rooms[roomId] = {
            id: roomId, mode: data.mode, difficulty: data.difficulty || 'normal',
            maxPlayers, status: 'waiting', bases: { left: 1000, right: 1000 },
            units: [], projectiles: [], effects: [],
            players: [{ id: socket.id, name: data.name, side: '', ready: false, color: COLORS[0], energy: 0, isBot: false }]
        };
        socket.join(roomId);
        if (data.mode === 'bot') {
            const r = rooms[roomId];
            r.players[0].side = 'left'; r.players[0].ready = true;
            r.players.push({ id: 'bot', name: 'AI Bot', side: 'right', ready: true, color: '#ff0000', energy: 0, isBot: true });
            r.status = 'playing';
            socket.emit('room_created', { roomId });
            io.to(roomId).emit('start_game', { players: r.players });
        } else {
            socket.emit('room_created', { roomId });
            updateLobby(roomId);
        }
    });

    socket.on('join_room', (data) => {
        const r = rooms[data.roomId.trim().toUpperCase()];
        if (r && r.status === 'waiting' && r.players.length < r.maxPlayers) {
            const usedColors = r.players.map(p => p.color);
            r.players.push({ 
                id: socket.id, name: data.name, side: '', ready: false, 
                color: COLORS.find(c => !usedColors.includes(c)) || '#fff', energy: 0, isBot: false 
            });
            socket.join(r.id);
            socket.emit('join_success', { roomId: r.id });
            updateLobby(r.id);
        } else {
            socket.emit('error_msg', 'Join failed');
        }
    });

    socket.on('select_side', (d) => {
        const r = rooms[d.roomId];
        if(!r) return;
        const p = r.players.find(x => x.id === socket.id);
        const limit = r.mode === '2v2' ? 2 : 1;
        if(p && r.players.filter(x => x.side === d.side).length < limit) {
            p.side = d.side; p.ready = false; updateLobby(d.roomId);
        }
    });

    socket.on('select_color', (d) => {
        const r = rooms[d.roomId];
        if(!r) return;
        if (!r.players.some(x => x.color === d.color && x.id !== socket.id)) {
            const p = r.players.find(x => x.id === socket.id);
            if(p) { p.color = d.color; updateLobby(d.roomId); }
        }
    });

    socket.on('toggle_ready', (rid) => {
        const r = rooms[rid];
        if(!r) return;
        const p = r.players.find(x => x.id === socket.id);
        if(p) p.ready = !p.ready;
        updateLobby(rid);
        
        const hasL = r.players.some(x=>x.side==='left');
        const hasR = r.players.some(x=>x.side==='right');
        if (r.players.length >= 2 && r.players.every(x => x.ready && x.side) && hasL && hasR) {
            r.status = 'playing';
            io.to(rid).emit('start_game', { players: r.players });
        }
    });

    socket.on('spawn_request', (d) => {
        const r = rooms[d.roomId];
        if (r && r.status === 'playing') {
            const p = r.players.find(x => x.id === socket.id);
            if(p) spawnUnit(r, p, d.type);
        }
    });

    socket.on('send_chat', (d) => {
        const r = rooms[d.roomId];
        if(r) {
            const p = r.players.find(x => x.id === socket.id);
            if(p) io.to(d.roomId).emit('chat_msg', { name: p.name, msg: d.msg, color: p.color });
        }
    });

    // [NEW] Event: เริ่มค้นหาห้อง
    socket.on('find_match', (data) => {
        // เช็คว่าอยู่ในคิวหรือยัง
        if (!matchQueue.some(p => p.id === socket.id)) {
            matchQueue.push({ id: socket.id, name: data.name });
            console.log(`User ${data.name} joined queue. Total: ${matchQueue.length}`);
            checkMatchQueue(); // ลองจับคู่ดู
        }
    });

    // [NEW] Event: ยกเลิกการค้นหา
    socket.on('cancel_match', () => {
        const idx = matchQueue.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            matchQueue.splice(idx, 1);
            console.log(`User left queue. Total: ${matchQueue.length}`);
        }
    });

    socket.on('disconnect', () => {
        // [NEW] ลบออกจากคิวถ้าหลุด
        const qIdx = matchQueue.findIndex(p => p.id === socket.id);
        if (qIdx !== -1) matchQueue.splice(qIdx, 1);

        for (const rid in rooms) {
            const r = rooms[rid];
            const idx = r.players.findIndex(p => p.id === socket.id);
            if(idx !== -1) {
                r.players.splice(idx, 1);
                if(r.players.length === 0) delete rooms[rid];
                else if(r.status === 'playing') {
                    io.to(rid).emit('error_msg', 'Player disconnected!');
                    delete rooms[rid];
                } else updateLobby(rid);
            }
        }
    });
});

function updateLobby(rid) {
    if(rooms[rid]) io.to(rid).emit('update_lobby', { players: rooms[rid].players, colors: COLORS });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));