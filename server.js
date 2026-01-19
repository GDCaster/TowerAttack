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

// Update Specs
const SPECS = {
    sword:    { hp: 40,  dmg: 5,  range: 50,  speed: 2.5, size: 30, cost: 20, atkRate: 800 },
    bow:      { hp: 20,  dmg: 4,  range: 300, speed: 2.5, size: 30, cost: 50, atkRate: 1200 }, // ปรับราคาเป็น 50
    tank:     { hp: 120, dmg: 2,  range: 50,  speed: 1.2, size: 36, cost: 70, atkRate: 1200 },
    mage:     { hp: 30,  dmg: 12, range: 250, speed: 1.8, size: 30, cost: 100, atkRate: 1500, type:'aoe', radius: 60 }, // Buff AoE
    assassin: { hp: 25,  dmg: 8,  range: 40,  speed: 4.0, size: 25, cost: 50, atkRate: 600, special: 'jump' }, // ตัวล้วง
    cannon:   { hp: 60,  dmg: 20, range: 400, speed: 1.5, size: 40, cost: 100, atkRate: 2000, type:'aoe', radius: 100 } // ปืนใหญ่ AoE
};

const BOT_SETTINGS = {
    easy:   { regen: 0.1,  aggro: 0.02 },
    normal: { regen: 0.2,  aggro: 0.05 },
    hard:   { regen: 0.35, aggro: 0.1 }
};

const COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#3742fa', 
    '#2f3542', '#8e44ad', '#e84393', '#00d2d3', '#fff200'
];

let rooms = {};

// --- GAME LOOP (20 FPS) ---
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        
        // Cleanup เช็คห้องที่ไม่มีคนหรือจบไปนานแล้ว
        if (room.players.length === 0) {
            delete rooms[roomId];
            continue;
        }

        if (room.status === 'playing') {
            updateGame(room);
            
            // ส่งข้อมูลให้ทุกคน
            room.players.forEach(player => {
                if(player.isBot) return;
                io.to(player.id).emit('world_update', {
                    b: room.bases,
                    myEng: Math.floor(player.energy),
                    u: room.units.map(u => ({
                        i: u.id, t: u.type, s: u.side, c: u.color,
                        x: Math.round(u.x), y: Math.round(u.y), h: u.hp,
                        act: u.action
                    })),
                    proj: room.projectiles.map(p => ({
                        x: Math.round(p.x), y: Math.round(p.y), t: p.type
                    })),
                    fx: room.effects
                });
            });
            // Clear Effects เพื่อไม่ให้ข้อมูลค้างสะสม
            room.effects = [];
        }
    }
}, 50);

function updateGame(room) {
    const now = Date.now();

    // 1. Regen Energy & AI
    room.players.forEach(p => {
        if (p.energy < MAX_ENERGY) {
            const rate = p.isBot ? BOT_SETTINGS[room.difficulty].regen : 0.2;
            p.energy += rate;
        }
        if (p.isBot) runBotLogic(room, p);
    });

    // 2. Physics & Logic Units
    // ลบตัวตายออกจาก Array ทันทีเพื่อลด Memory
    for (let i = room.units.length - 1; i >= 0; i--) {
        if (room.units[i].dead) room.units.splice(i, 1);
    }

    room.units.forEach(u => {
        u.action = 'idle';
        let target = null;
        let minDist = 999;

        // หาเป้าหมายที่ใกล้ที่สุด
        room.units.forEach(o => {
            if (o.side !== u.side && !o.dead) {
                const dist = Math.hypot(u.x - o.x, u.y - o.y);
                if (dist < minDist) { minDist = dist; target = o; }
            }
        });

        // Logic Assassin: วาร์ปถ้าเจอ Mage หรือ Bow
        if (u.type === 'assassin' && target && !u.hasJumped && minDist < 300) {
            if (target.type === 'bow' || target.type === 'mage' || target.type === 'cannon') {
                const offset = u.side === 'left' ? 40 : -40;
                u.x = target.x + offset; // วาร์ปไปหลัง
                u.y = target.y;
                u.hasJumped = true;
                room.effects.push({ type: 'warp', x: u.x, y: u.y });
            }
        }

        // เช็คการโจมตีฐาน
        const canHitBase = (u.side === 'left' && u.x >= WORLD_W - 250) || (u.side === 'right' && u.x <= 250);
        
        // ระยะโจมตี
        const attackRange = SPECS[u.type].range;
        const inRange = target && minDist <= attackRange;

        if (canHitBase) {
            // ตีฐาน
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';
                const targetSide = u.side === 'left' ? 'right' : 'left';
                room.bases[targetSide] -= u.dmg;
                
                const baseX = u.side === 'left' ? WORLD_W - 100 : 100;
                room.effects.push({ type: 'dmg', x: baseX, y: WORLD_H/2, val: u.dmg });

                if (room.bases[targetSide] <= 0) endGame(room, u.side);
            }
        } else if (inRange) {
            // ตีคน
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now;
                u.action = 'attack';

                // ถ้าเป็นตัวยิงไกล/ปืนใหญ่ ให้ยิง Projectile
                if (u.type === 'mage' || u.type === 'cannon') {
                    spawnProjectile(room, u, target);
                } else {
                    // ตีระยะประชิด (Melee & Bow Hit-scan)
                    target.hp -= u.dmg;
                    room.effects.push({ type: 'dmg', x: target.x, y: target.y, val: u.dmg });
                    if (target.hp <= 0) target.dead = true;
                }
            }
        } else {
            // เดิน
            const dir = u.side === 'left' ? 1 : -1;
            u.x += dir * u.speed;
            u.action = 'walk';
            
            // เดินเลี้ยงเลนกลาง
            const mid = WORLD_H / 2;
            if (u.y < mid - 100) u.y += 0.5;
            if (u.y > mid + 100) u.y -= 0.5;
        }
    });

    // 3. Update Projectiles
    updateProjectiles(room);
}

function spawnProjectile(room, owner, target) {
    room.projectiles.push({
        x: owner.x,
        y: owner.y,
        tx: target.x,
        ty: target.y,
        speed: owner.type === 'cannon' ? 15 : 12,
        dmg: SPECS[owner.type].dmg,
        radius: SPECS[owner.type].radius,
        type: owner.type, // 'mage' or 'cannon'
        side: owner.side
    });
}

function updateProjectiles(room) {
    for (let i = room.projectiles.length - 1; i >= 0; i--) {
        const p = room.projectiles[i];
        
        // คำนวณทิศทาง
        const dx = p.tx - p.x;
        const dy = p.ty - p.y;
        const dist = Math.hypot(dx, dy);

        if (dist < p.speed) {
            // ถึงเป้าหมาย -> ระเบิด AoE
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
            // Effect ระเบิด
            room.effects.push({ type: 'aoe', x: p.tx, y: p.ty, r: p.radius, t: p.type });
            room.projectiles.splice(i, 1);
        } else {
            // เคลื่อนที่
            const angle = Math.atan2(dy, dx);
            p.x += Math.cos(angle) * p.speed;
            p.y += Math.sin(angle) * p.speed;
        }
    }
}

function runBotLogic(room, bot) {
    if (Math.random() < BOT_SETTINGS[room.difficulty].aggro) {
        const types = ['sword', 'bow', 'tank', 'mage', 'assassin', 'cannon'];
        const affordable = types.filter(t => bot.energy >= SPECS[t].cost);
        if (affordable.length > 0) {
            const type = affordable[Math.floor(Math.random() * affordable.length)];
            spawnUnit(room, bot, type);
        }
    }
}

function spawnUnit(room, player, type) {
    if (player.energy < SPECS[type].cost) return;
    
    player.energy -= SPECS[type].cost;
    const batchId = Date.now() + Math.random();
    
    // Spawn 5 ตัวเหมือนเดิม
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
            action: 'idle',
            hasJumped: false // สำหรับ Assassin
        });
    }
}

function endGame(room, winner) {
    room.status = 'finished';
    io.to(room.id).emit('game_over', { winner });
    setTimeout(() => { delete rooms[room.id]; }, 2000); // ลบห้องเร็วขึ้นเพื่อลดแลค
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
            projectiles: [],
            effects: [],
            players: [{ 
                id: socket.id, 
                name: data.name, 
                side: '', 
                ready: false, 
                color: COLORS[0],
                energy: 0,
                isBot: false 
            }]
        };
        
        socket.join(roomId);
        
        if (data.mode === 'bot') {
            const r = rooms[roomId];
            r.players[0].side = 'left';
            r.players[0].ready = true;
            r.players.push({
                id: 'bot_1', name: 'AI Bot', side: 'right', ready: true, 
                color: '#ff0000', energy: 0, isBot: true
            });
            r.status = 'playing';
            socket.emit('room_created', { roomId });
            io.to(roomId).emit('start_game', { players: r.players });
        } else {
            socket.emit('room_created', { roomId });
            updateLobby(roomId);
        }
    });

    socket.on('join_room', (data) => {
        const code = data.roomId.trim().toUpperCase();
        const r = rooms[code];
        
        if (r && r.status === 'waiting' && r.players.length < r.maxPlayers) {
            // สุ่มสีที่ไม่ซ้ำเพื่อน
            const usedColors = r.players.map(p => p.color);
            const availColor = COLORS.find(c => !usedColors.includes(c)) || '#fff';

            r.players.push({ 
                id: socket.id, 
                name: data.name, 
                side: '', 
                ready: false, 
                color: availColor,
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
        const limit = r.mode === '2v2' ? 2 : 1;
        const currentCount = r.players.filter(pl => pl.side === data.side && pl.id !== socket.id).length;
        
        if(currentCount < limit && p) {
            p.side = data.side;
            p.ready = false;
            updateLobby(data.roomId);
        }
    });

    socket.on('select_color', (data) => {
        const r = rooms[data.roomId];
        if(!r) return;
        
        // เช็คว่าสีซ้ำคนอื่นไหม
        const isTaken = r.players.some(pl => pl.color === data.color && pl.id !== socket.id);
        if(!isTaken) {
            const p = r.players.find(pl => pl.id === socket.id);
            if(p) p.color = data.color;
            updateLobby(data.roomId);
        }
    });

    socket.on('toggle_ready', (roomId) => {
        const r = rooms[roomId];
        if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p && p.side) p.ready = !p.ready;
        
        updateLobby(roomId);

        const allReady = r.players.every(pl => pl.ready && pl.side);
        const hasLeft = r.players.some(pl => pl.side === 'left');
        const hasRight = r.players.some(pl => pl.side === 'right');
        
        if (r.players.length >= 2 && allReady && hasLeft && hasRight) {
            r.status = 'playing';
            io.to(roomId).emit('start_game', { players: r.players });
        }
    });

    socket.on('spawn_request', (data) => {
        const r = rooms[data.roomId];
        if (r && r.status === 'playing') {
            const p = r.players.find(pl => pl.id === socket.id);
            if (p) spawnUnit(r, p, data.type);
        }
    });

    socket.on('send_chat', (data) => {
        const r = rooms[data.roomId];
        if(r) {
            const p = r.players.find(pl => pl.id === socket.id);
            if(p) {
                io.to(data.roomId).emit('chat_msg', { name: p.name, msg: data.msg, color: p.color });
            }
        }
    });
    
    socket.on('disconnect', () => {
        for (const rid in rooms) {
            const r = rooms[rid];
            const idx = r.players.findIndex(p => p.id === socket.id);
            if(idx !== -1) {
                r.players.splice(idx, 1);
                if(r.players.length === 0) {
                    delete rooms[rid];
                } else if(r.status === 'playing') {
                    io.to(rid).emit('error_msg', 'ผู้เล่นหลุดการเชื่อมต่อ - จบเกม');
                    delete rooms[rid];
                } else {
                    updateLobby(rid);
                }
            }
        }
    });
});

function updateLobby(roomId) {
    if(rooms[roomId]) {
        io.to(roomId).emit('update_lobby', { 
            players: rooms[roomId].players,
            colors: COLORS 
        });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));