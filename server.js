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

// [EDITED] กำหนด Max Energy ตามเลเวล (0 ถึง 5)
const MAX_ENERGY_LEVELS = [300, 450, 600, 800, 1000, 1500];

// Upgrade Config
const UPGRADE_COSTS = [50, 100, 150, 250, 400];
const REGEN_RATES = [0.15, 0.22, 0.30, 0.40, 0.55, 0.75];

// *** LIMITS & SPECS CONFIG ***
const SPECS = {
    sword:    { hp: 25,  dmg: 5,  range: 50,  speed: 2.5, size: 30, cost: 20, atkRate: 1200, limit: 20, type: 'melee' },
    bow:      { hp: 20,  dmg: 5,  range: 300, speed: 2.5, size: 30, cost: 45, atkRate: 1500, limit: 15, type: 'ranged' },
    tank:     { hp: 250, dmg: 2,  range: 50,  speed: 2.5, size: 36, cost: 100, atkRate: 2000, limit: 15, type: 'melee', 
                chargeSpeed: 3.75, impactRadius: 50, stunDur: 500, knockback: 5 }, 
    mage:     { hp: 25,  dmg: 15, range: 250, speed: 2.0, size: 30, cost: 125, atkRate: 1000, limit: 20, type: 'aoe', radius: 25, baseType: 'ranged' },
    assassin: { hp: 5,  dmg: 15,  range: 65,  speed: 6.0, size: 25, cost: 80, atkRate: 2000,  limit: 15, type: 'hybrid', radius: 75, jumpRange: 250, jumpCd: 7000 },
    cannon:   { hp: 60,  dmg: 20, range: 350, speed: 1.5, size: 40, cost: 205, atkRate: 4500, limit: 15, type: 'aoe', radius: 70, baseType: 'ranged' },
    healer:   { hp: 25,  dmg: 0,  range: 150, speed: 2.5, size: 28, cost: 50, atkRate: 3000, limit: 15, type: 'support', radius: 195, baseType: 'ranged' },
    sniper:   { hp: 20,  dmg: 65, range: 400, speed: 2.0, size: 30, cost: 125, atkRate: 10000, limit: 10, type: 'ranged', aimTime: 2500 }
};

const BOT_SETTINGS = {
    easy:   { regenIdx: 0,  aggro: 0.02 },
    normal: { regenIdx: 2,  aggro: 0.05 },
    hard:   { regenIdx: 4, aggro: 0.12 }
};

const COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#3742fa', 
    '#2f3542', '#8e44ad', '#e84393', '#00d2d3', '#fff200'
];

let rooms = {};
let matchQueue = [];

// Game Loop
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.players.length === 0) {
            delete rooms[roomId];
            continue;
        }
        
        if (room.autoStartTimer && room.status === 'waiting') {
            const timeLeft = Math.ceil((room.autoStartTime - Date.now()) / 1000);
            if (timeLeft <= 0) forceStartGame(roomId);
        }

        if (room.status === 'playing') {
            updateGame(room);

            if (typeof room.serverTick === 'undefined') room.serverTick = 0;
            room.serverTick++;

            // OPTIMIZATION: ส่งข้อมูลทุกๆ 4 Tick (200ms)
            if (room.serverTick % 4 === 0) {
                const packet = {
                    b: room.bases,
                    u: room.units.map(u => [
                        u.id, 
                        u.type, 
                        u.side,
                        Math.round(u.x), 
                        Math.round(u.y), 
                        u.hp,
                        u.isStunned ? 'stun' : u.action, 
                        u.aimTargetId || null, 
                        u.color,
                        // [NEW] ส่งสถานะโล่ Mage หรืออมตะไปให้ Client (ใช้ effect แทน หรือดูที่สี)
                        (u.type === 'mage' && (u.mageShield || u.invincibleTime > Date.now())) ? 1 : 0 
                    ]),
                    proj: room.projectiles.map(p => [
                        Math.round(p.x), 
                        Math.round(p.y), 
                        p.type
                    ]),
                    fx: room.effects 
                };
                
                room.players.forEach(player => {
                    if(player.isBot) return;
                    packet.myEng = Math.floor(player.energy);
                    packet.myLvl = player.energyLevel; 
                    io.to(player.id).emit('world_update', packet);
                });

                room.effects = [];
            }
        }
    }
}, 50);

// [NEW] ฟังก์ชันจัดการ Damage กลาง (รองรับ Mage Shield)
function applyDamage(room, unit, dmg, sourceX, sourceY) {
    if (unit.dead) return;
    const now = Date.now();

    // --- MAGE DEFENSE MECHANIC ---
    if (unit.type === 'mage') {
        // ถ้าอยู่ในช่วงอมตะ
        if (unit.invincibleTime && now < unit.invincibleTime) {
            return; // ไม่โดนดาเมจ
        }

        // ถ้ามีโล่ (โดนครั้งแรก)
        if (unit.mageShield) {
            unit.mageShield = false;
            unit.invincibleTime = now + 5000; // อมตะ 5 วินาที
            
            // Visual Effect: Block text
            room.effects.push({ type: 'text', x: unit.x, y: unit.y, val: 'BLOCK', color: '#fff' });
            
            // Visual Effect: Explosion Ring
            room.effects.push({ type: 'aoe', x: unit.x, y: unit.y, r: 75, t: 'mage_blast' });

            // Logic: Stun ศัตรูรอบๆ 75 หน่วย เป็นเวลา 1 วินาที
            room.units.forEach(e => {
                if (e.side !== unit.side && !e.dead) {
                    const dist = Math.hypot(unit.x - e.x, unit.y - e.y);
                    if (dist <= 75) {
                        e.stunEndTime = now + 1000;
                        e.action = 'stun';
                        // ผลักออกนิดหน่อย
                        const angle = Math.atan2(e.y - unit.y, e.x - unit.x);
                        e.x += Math.cos(angle) * 20;
                        e.y += Math.sin(angle) * 20;
                    }
                }
            });
            return; // จบการทำงาน (ไม่โดนดาเมจครั้งนี้)
        }
    }

    // Normal Damage
    unit.hp -= dmg;
    room.effects.push({ type: 'dmg', x: unit.x, y: unit.y, val: dmg });
    if (unit.hp <= 0) unit.dead = true;
}

function updateGame(room) {
    const now = Date.now();
    
    // Regen Energy System
    room.players.forEach(p => {
        const currentMaxEnergy = MAX_ENERGY_LEVELS[p.energyLevel] || MAX_ENERGY_LEVELS[MAX_ENERGY_LEVELS.length - 1];
        if (p.energy < currentMaxEnergy) {
            let rIndex = p.energyLevel;
            if(p.isBot) rIndex = BOT_SETTINGS[room.difficulty].regenIdx;
            
            const rate = REGEN_RATES[Math.min(rIndex, REGEN_RATES.length - 1)];
            p.energy += rate;
            if (p.energy > currentMaxEnergy) p.energy = currentMaxEnergy;
        }
        if (p.isBot) runBotLogic(room, p);
    });

    // Clean Dead Units
    for (let i = room.units.length - 1; i >= 0; i--) {
        if (room.units[i].dead) room.units.splice(i, 1);
    }

    // Unit Logic
    room.units.forEach(u => {
        
        // --- STUN LOGIC ---
        if (u.stunEndTime && now < u.stunEndTime) {
            u.isStunned = true;
            u.action = 'stun';
            return; 
        } else {
            u.isStunned = false;
        }

        // --- TANK CHARGE LOGIC ---
        if (u.type === 'tank' && u.charging) {
            u.action = 'walk';
            const enemyHit = room.units.find(e => e.side !== u.side && !e.dead && Math.hypot(u.x - e.x, u.y - e.y) < (u.size + e.size));
            const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
            const distToBase = Math.abs(u.x - enemyBaseX);
            
            if (enemyHit || distToBase <= SPECS.tank.range) {
                u.charging = false; 
                room.effects.push({ type: 'aoe', x: u.x, y: u.y, r: SPECS.tank.impactRadius, t: 'impact' });
                
                room.units.forEach(e => {
                    if (e.side !== u.side && !e.dead) {
                        const dist = Math.hypot(u.x - e.x, u.y - e.y);
                        if (dist <= SPECS.tank.impactRadius) {
                            e.stunEndTime = now + SPECS.tank.stunDur;
                            e.action = 'stun';
                            const angle = Math.atan2(e.y - u.y, e.x - u.x);
                            e.x += Math.cos(angle) * SPECS.tank.knockback;
                            e.y += Math.sin(angle) * SPECS.tank.knockback;
                            if(e.y < 50) e.y = 50; if(e.y > WORLD_H-50) e.y = WORLD_H-50;
                        }
                    }
                });
            } else {
                const dir = u.side === 'left' ? 1 : -1;
                u.x += dir * SPECS.tank.chargeSpeed;
                const mid = WORLD_H / 2;
                if (u.y < mid - 50) u.y += 0.5;
                if (u.y > mid + 50) u.y -= 0.5;
                return; 
            }
        }

        // --- SNIPER LOGIC ---
        if (u.type === 'sniper') {
            const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
            const distToBase = Math.abs(u.x - enemyBaseX);
            
            if (u.aiming) {
                u.action = 'idle';
                let targetExists = false;
                if (u.aimTargetType === 'base') {
                     if (room.bases[u.side === 'left' ? 'right' : 'left'] > 0) targetExists = true;
                } else {
                    const foundTarget = room.units.find(e => e.id === u.aimTargetId && !e.dead);
                    if (foundTarget) targetExists = true;
                }
                if (!targetExists) { u.aiming = false; u.aimTargetId = null; return; }
                if (now - u.aimStartTime >= SPECS.sniper.aimTime) {
                    u.lastAttack = now; u.aiming = false;
                    if (u.aimTargetType === 'base') {
                        spawnProjectile(room, u, { id: null, x: enemyBaseX, y: WORLD_H/2, dead: false });
                    } else {
                        const targetUnit = room.units.find(e => e.id === u.aimTargetId);
                        if (targetUnit) { spawnProjectile(room, u, targetUnit); }
                    }
                    u.aimTargetId = null;
                }
                return;
            }
            if (now - u.lastAttack < SPECS.sniper.atkRate) { u.action = 'idle'; return; }
            let potentialTarget = null; let minDist = 999;
            room.units.forEach(o => {
                if (o.side !== u.side && !o.dead) {
                    const dist = Math.hypot(u.x - o.x, u.y - o.y);
                    if (dist < minDist && dist <= SPECS.sniper.range) { minDist = dist; potentialTarget = o; }
                }
            });
            if (potentialTarget) {
                u.aiming = true; u.aimStartTime = now; u.aimTargetId = potentialTarget.id; u.aimTargetType = 'unit'; u.action = 'idle';
            } else if (distToBase <= SPECS.sniper.range) {
                u.aiming = true; u.aimStartTime = now; u.aimTargetId = 'base_' + (u.side === 'left' ? 'right' : 'left'); u.aimTargetType = 'base'; u.action = 'idle';
            } else {
                u.x += (u.side === 'left' ? 1 : -1) * u.speed;
                u.action = 'walk';
                const mid = WORLD_H / 2;
                if (u.y < mid - 100) u.y += 0.5;
                if (u.y > mid + 100) u.y -= 0.5;
            }
            return;
        }

        u.action = 'idle';

        // --- HEALER LOGIC ---
        if (u.type === 'healer') {
            const friendsToHeal = room.units.filter(friend => 
                friend.side === u.side && !friend.dead && friend.id !== u.id &&
                Math.hypot(u.x - friend.x, u.y - friend.y) <= SPECS.healer.radius &&
                friend.hp < SPECS[friend.type].hp
            );
            const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
            const distToBase = Math.abs(u.x - enemyBaseX);

            if (friendsToHeal.length > 0 || distToBase <= SPECS.healer.range) {
                u.action = 'idle';
                if (friendsToHeal.length > 0 && now - u.lastAttack > SPECS.healer.atkRate) {
                    u.lastAttack = now;
                    friendsToHeal.forEach(f => {
                        f.hp += 5;
                        if (f.hp > SPECS[f.type].hp) f.hp = SPECS[f.type].hp;
                        room.effects.push({ type: 'heal', x: f.x, y: f.y, val: 5 });
                    });
                    room.effects.push({ type: 'aoe', x: u.x, y: u.y, r: SPECS.healer.radius, t: 'healer' });
                }
            } else {
                u.x += (u.side === 'left' ? 1 : -1) * u.speed;
                u.action = 'walk';
            }
            if (u.y < (WORLD_H/2) - 100) u.y += 0.5;
            if (u.y > (WORLD_H/2) + 100) u.y -= 0.5;
            return;
        }

        // --- ASSASSIN LOGIC ---
        if (u.type === 'assassin') {
            const enemiesInJumpRange = room.units.filter(e => e.side !== u.side && !e.dead && Math.hypot(u.x - e.x, u.y - e.y) <= SPECS.assassin.jumpRange);
            let jumpTarget = null;
            if (!u.jumpReadyTime || now > u.jumpReadyTime) {
                if (enemiesInJumpRange.length > 0) {
                    const rangedTargets = enemiesInJumpRange.filter(e => ['bow', 'mage', 'cannon', 'sniper', 'healer'].includes(e.type));
                    if (rangedTargets.length > 0) {
                        rangedTargets.sort((a, b) => Math.hypot(u.x - b.x, u.y - b.y) - Math.hypot(u.x - a.x, u.y - a.y));
                        jumpTarget = rangedTargets[0];
                    } else {
                        enemiesInJumpRange.sort((a, b) => Math.hypot(u.x - a.x, u.y - a.y) - Math.hypot(u.x - b.x, u.y - b.y));
                        jumpTarget = enemiesInJumpRange[0];
                    }
                }
                if (jumpTarget) {
                    const dist = Math.hypot(u.x - jumpTarget.x, u.y - jumpTarget.y);
                    if (dist > 50) { 
                        const offset = u.side === 'left' ? 40 : -40;
                        u.x = jumpTarget.x + offset; 
                        u.y = jumpTarget.y;
                        u.jumpReadyTime = now + SPECS.assassin.jumpCd;
                        
                        room.effects.push({ type: 'warp', x: u.x, y: u.y });
                        room.effects.push({ type: 'aoe', x: u.x, y: u.y, r: SPECS.assassin.radius, t: 'assassin' });
                        
                        room.units.forEach(e => {
                            if (e.side !== u.side && !e.dead && Math.hypot(u.x - e.x, u.y - e.y) <= SPECS.assassin.radius) {
                                // ใช้ applyDamage
                                applyDamage(room, e, 15, u.x, u.y);
                            }
                        });

                        u.lastAttack = now; 
                        return; 
                    }
                }
            }
        }

        // --- NORMAL UNITS LOGIC (Walk & Attack) ---
        let target = null;
        let minDist = 999;

        room.units.forEach(o => {
            if (o.side !== u.side && !o.dead) {
                const dist = Math.hypot(u.x - o.x, u.y - o.y);
                if (dist < minDist) { minDist = dist; target = o; }
            }
        });

        const enemyBaseX = u.side === 'left' ? WORLD_W - 100 : 100;
        const distToBase = Math.abs(u.x - enemyBaseX);
        const canHitBase = distToBase <= SPECS[u.type].range;
        
        if (canHitBase) {
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now; u.action = 'attack';
                const targetSide = u.side === 'left' ? 'right' : 'left';
                room.bases[targetSide] -= u.dmg;
                room.effects.push({ type: 'dmg', x: enemyBaseX, y: WORLD_H/2, val: u.dmg });
                if (room.bases[targetSide] <= 0) endGame(room, u.side);
            }
        } else if (target && minDist <= SPECS[u.type].range) {
            if (now - u.lastAttack > SPECS[u.type].atkRate) {
                u.lastAttack = now; u.action = 'attack';
                if (['mage', 'cannon', 'bow', 'sniper'].includes(u.type)) { spawnProjectile(room, u, target); } 
                else {
                    // ใช้ applyDamage สำหรับ Melee
                    applyDamage(room, target, u.dmg, u.x, u.y);
                }
            }
        } else {
            u.action = 'walk';
            if (target) {
                const dx = target.x - u.x;
                const dy = target.y - u.y;
                const angle = Math.atan2(dy, dx);
                u.x += Math.cos(angle) * u.speed;
                u.y += Math.sin(angle) * u.speed;
            } else {
                const dir = u.side === 'left' ? 1 : -1;
                u.x += dir * u.speed;
                const mid = WORLD_H / 2;
                if (u.y < mid - 100) u.y += 0.5;
                if (u.y > mid + 100) u.y -= 0.5;
            }
        }
    });

    updateProjectiles(room);
}

function spawnProjectile(room, owner, target) {
    let speed = 10;
    if (owner.type === 'cannon') speed = 14;
    if (owner.type === 'sniper') speed = 25; 

    room.projectiles.push({
        x: owner.x, y: owner.y, 
        targetId: target.id, 
        tx: target.x, ty: target.y, 
        speed: speed, 
        dmg: SPECS[owner.type].dmg, 
        radius: SPECS[owner.type].radius || 10, 
        type: owner.type, 
        side: owner.side
    });
}

function updateProjectiles(room) {
    for (let i = room.projectiles.length - 1; i >= 0; i--) {
        const p = room.projectiles[i];

        if (p.targetId) {
            const target = room.units.find(u => u.id === p.targetId);
            if (target && !target.dead) { p.tx = target.x; p.ty = target.y; }
        }

        const dx = p.tx - p.x, dy = p.ty - p.y;
        const dist = Math.hypot(dx, dy);

        if (dist < p.speed) {
            let hit = false;
            
            // [EDITED] Sniper Logic: Single Target only
            if (p.type === 'sniper') {
                // หากระสุน Sniper ที่ชนยูนิต (หาตัวที่ใกล้ที่สุดในระยะ hit range)
                let targets = [];
                room.units.forEach(u => {
                    if (u.side !== p.side && !u.dead) {
                        const d = Math.hypot(u.x - p.tx, u.y - p.ty);
                        if (d <= 30) { targets.push({ unit: u, dist: d }); }
                    }
                });

                if (targets.length > 0) {
                    // เรียงตามระยะ หาตัวใกล้สุด
                    targets.sort((a, b) => a.dist - b.dist);
                    applyDamage(room, targets[0].unit, p.dmg, p.tx, p.ty);
                    hit = true;
                }

            } else {
                // กระสุนปกติ (อาจเป็น AoE หรือ Single)
                room.units.forEach(u => {
                    if (u.side !== p.side && !u.dead) {
                        const d = Math.hypot(u.x - p.tx, u.y - p.ty);
                        if (d <= p.radius) {
                            applyDamage(room, u, p.dmg, p.tx, p.ty);
                            hit = true;
                        }
                    }
                });
            }

            // Sniper ยิงฐาน
            if (p.type === 'sniper' && !p.targetId && !hit) {
                 const enemyBaseX = p.side === 'left' ? WORLD_W - 100 : 100;
                 if (Math.abs(p.tx - enemyBaseX) < 50) {
                     const targetSide = p.side === 'left' ? 'right' : 'left';
                     room.bases[targetSide] -= p.dmg;
                     room.effects.push({ type: 'dmg', x: p.tx, y: p.ty, val: p.dmg });
                     if (room.bases[targetSide] <= 0) endGame(room, p.side);
                 }
            }

            if (p.type === 'mage' || p.type === 'cannon') { 
                room.effects.push({ type: 'aoe', x: p.tx, y: p.ty, r: p.radius, t: p.type }); 
            }
            
            // ลบกระสุนทันทีเมื่อถึงเป้าหมาย
            room.projectiles.splice(i, 1);

        } else {
            const angle = Math.atan2(dy, dx);
            p.x += Math.cos(angle) * p.speed; p.y += Math.sin(angle) * p.speed;
        }
    }
}

function runBotLogic(room, bot) {
    if (bot.energy > 400 && bot.energyLevel < 4) {
        bot.energy -= UPGRADE_COSTS[bot.energyLevel];
        bot.energyLevel++;
    }

    if (Math.random() < BOT_SETTINGS[room.difficulty].aggro) {
        const types = Object.keys(SPECS);
        const affordable = types.filter(t => bot.energy >= SPECS[t].cost);
        if (affordable.length > 0) { spawnUnit(room, bot, affordable[Math.floor(Math.random() * affordable.length)]); }
    }
}

function spawnUnit(room, player, type) {
    if (!SPECS[type]) return; 
    if (player.energy < SPECS[type].cost) return;

    const currentCount = room.units.filter(u => u.side === player.side && u.type === type && !u.dead).length;
    if (SPECS[type].limit && currentCount >= SPECS[type].limit) {
        return; 
    }

    const now = Date.now();
    if (!player.cooldowns) player.cooldowns = {};
    if (player.cooldowns[type] && now < player.cooldowns[type]) return;

    player.energy -= SPECS[type].cost;
    player.cooldowns[type] = now + 3000;

    const batchId = Date.now() + Math.random();
    const count = type === 'cannon' ? 3 : 5; 
    
    for (let i = 0; i < count; i++) {
        let u = {
            id: `${batchId}_${i}`, type, side: player.side, color: player.color, owner: player.name,
            x: player.side === 'left' ? 120 : WORLD_W - 120, y: (WORLD_H / 2) + (Math.random() * 200 - 100),
            hp: SPECS[type].hp, dmg: SPECS[type].dmg, range: SPECS[type].range, speed: SPECS[type].speed, size: SPECS[type].size,
            lastAttack: 0, dead: false, action: 'idle', jumpReadyTime: 0, aiming: false, aimStartTime: 0, aimTargetId: null,
            charging: (type === 'tank'), 
            stunEndTime: 0,
            // [NEW] Mage Properties
            mageShield: (type === 'mage'),
            invincibleTime: 0
        };
        room.units.push(u);
    }
}

function endGame(room, winner) {
    room.status = 'finished'; io.to(room.id).emit('game_over', { winner });
    setTimeout(() => { delete rooms[room.id]; }, 3000);
}

function forceStartGame(roomId) {
    const r = rooms[roomId];
    if(r && r.status === 'waiting') {
        r.status = 'playing'; r.autoStartTimer = null; io.to(roomId).emit('start_game', { players: r.players });
    }
}

function checkMatchQueue() {
    if (matchQueue.length >= 2) {
        const p1 = matchQueue.shift(); const p2 = matchQueue.shift();
        const roomId = "AUTO_" + Math.random().toString(36).substr(2, 5).toUpperCase();
        rooms[roomId] = {
            id: roomId, mode: '1v1', difficulty: 'normal', maxPlayers: 2, status: 'waiting', bases: { left: 1000, right: 1000 },
            units: [], projectiles: [], effects: [], players: [], isAutoMatch: true, autoStartTime: Date.now() + 30000, autoStartTimer: true
        };
        const r = rooms[roomId];
        r.players.push({ id: p1.id, name: p1.name, side: 'left', ready: false, color: COLORS[0], energy: 0, energyLevel: 0, isBot: false, cooldowns: {} });
        r.players.push({ id: p2.id, name: p2.name, side: 'right', ready: false, color: COLORS[1], energy: 0, energyLevel: 0, isBot: false, cooldowns: {} });
        const p1Socket = io.sockets.sockets.get(p1.id); const p2Socket = io.sockets.sockets.get(p2.id);
        if (p1Socket) { p1Socket.join(roomId); p1Socket.emit('join_success', { roomId, isAuto: true }); }
        if (p2Socket) { p2Socket.join(roomId); p2Socket.emit('join_success', { roomId, isAuto: true }); }
        io.to(roomId).emit('auto_match_timer', { seconds: 30 });
        updateLobby(roomId);
    }
}

io.on('connection', (socket) => {
    socket.on('create_room', (data) => {
        // [EDITED] Custom ID Check
        let roomId;
        if (data.customId && data.customId.trim() !== "") {
            roomId = data.customId.trim().toUpperCase();
            if (rooms[roomId]) {
                socket.emit('error_msg', 'ชื่อห้องนี้มีคนใช้แล้ว (Room ID exists)');
                return;
            }
        } else {
            roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
        }

        rooms[roomId] = {
            id: roomId, mode: data.mode, difficulty: data.difficulty || 'normal', 
            maxPlayers: data.mode === '2v2' ? 4 : 2,
            status: 'waiting', bases: { left: 1000, right: 1000 }, units: [], projectiles: [], effects: [],
            players: [{ id: socket.id, name: data.name, side: '', ready: false, color: COLORS[0], energy: 0, energyLevel: 0, isBot: false, cooldowns: {} }]
        };
        socket.join(roomId);
        if (data.mode === 'bot') {
            const r = rooms[roomId];
            r.players[0].side = 'left'; r.players[0].ready = true;
            r.players.push({ id: 'bot', name: 'AI Bot', side: 'right', ready: true, color: '#ff0000', energy: 0, energyLevel: 0, isBot: true });
            r.status = 'playing'; socket.emit('room_created', { roomId }); io.to(roomId).emit('start_game', { players: r.players });
        } else { socket.emit('room_created', { roomId }); updateLobby(roomId); }
    });

    socket.on('join_room', (data) => {
        const r = rooms[data.roomId.trim().toUpperCase()];
        if (r && r.status === 'waiting' && r.players.length < r.maxPlayers) {
            const usedColors = r.players.map(p => p.color);
            r.players.push({ id: socket.id, name: data.name, side: '', ready: false, color: COLORS.find(c => !usedColors.includes(c)) || '#fff', energy: 0, energyLevel: 0, isBot: false, cooldowns: {} });
            socket.join(r.id); socket.emit('join_success', { roomId: r.id }); updateLobby(r.id);
        } else { socket.emit('error_msg', 'เข้าร่วมไม่ได้ (ไม่พบห้อง หรือห้องเต็ม)'); }
    });

    socket.on('select_side', (d) => {
        const r = rooms[d.roomId]; if(!r || r.isAutoMatch) return;
        const p = r.players.find(x => x.id === socket.id);
        
        // [EDITED] Sandbox ไม่จำกัดจำนวนคนในฝั่ง
        const limit = r.mode === '2v2' ? 2 : (r.mode === 'sandbox' ? 99 : 1);
        
        if(p && r.players.filter(x => x.side === d.side).length < limit) { p.side = d.side; p.ready = false; updateLobby(d.roomId); }
    });

    socket.on('select_color', (d) => {
        const r = rooms[d.roomId]; if(!r) return;
        if (!r.players.some(x => x.color === d.color && x.id !== socket.id)) {
            const p = r.players.find(x => x.id === socket.id); if(p) { p.color = d.color; updateLobby(d.roomId); }
        }
    });

    socket.on('toggle_ready', (rid) => {
        const r = rooms[rid]; if(!r) return;
        const p = r.players.find(x => x.id === socket.id); if(p) p.ready = !p.ready;
        updateLobby(rid);
        
        const hasL = r.players.some(x=>x.side==='left');
        const hasR = r.players.some(x=>x.side==='right');
        
        // [EDITED] Sandbox Start Logic (เริ่มได้เลยถ้า Ready แม้มีคนเดียว)
        if (r.mode === 'sandbox') {
             if (r.players.length > 0 && r.players.every(x => x.ready && x.side)) {
                r.status = 'playing'; r.autoStartTimer = null; io.to(rid).emit('start_game', { players: r.players });
             }
        } else {
            // Normal Logic
            if (r.players.length >= 2 && r.players.every(x => x.ready && x.side) && hasL && hasR) {
                r.status = 'playing'; r.autoStartTimer = null; io.to(rid).emit('start_game', { players: r.players });
            }
        }
    });

    socket.on('spawn_request', (d) => {
        const r = rooms[d.roomId];
        if (r && r.status === 'playing') {
            const p = r.players.find(x => x.id === socket.id); if(p) spawnUnit(r, p, d.type);
        }
    });

    // Handle Upgrade Request
    socket.on('upgrade_energy', (d) => {
        const r = rooms[d.roomId];
        if (r && r.status === 'playing') {
            const p = r.players.find(x => x.id === socket.id);
            if (p && p.energyLevel < 5) {
                const cost = UPGRADE_COSTS[p.energyLevel];
                if (p.energy >= cost) {
                    p.energy -= cost;
                    p.energyLevel++;
                }
            }
        }
    });

    socket.on('send_chat', (d) => {
        const r = rooms[d.roomId];
        if(r) {
            const p = r.players.find(x => x.id === socket.id); if(p) io.to(d.roomId).emit('chat_msg', { name: p.name, msg: d.msg, color: p.color });
        }
    });

    socket.on('find_match', (data) => {
        if (!matchQueue.some(p => p.id === socket.id)) { matchQueue.push({ id: socket.id, name: data.name }); checkMatchQueue(); }
    });

    socket.on('cancel_match', () => {
        const idx = matchQueue.findIndex(p => p.id === socket.id); if (idx !== -1) matchQueue.splice(idx, 1);
    });

    socket.on('disconnect', () => {
        const qIdx = matchQueue.findIndex(p => p.id === socket.id); if (qIdx !== -1) matchQueue.splice(qIdx, 1);
        for (const rid in rooms) {
            const r = rooms[rid]; const idx = r.players.findIndex(p => p.id === socket.id);
            if(idx !== -1) {
                r.players.splice(idx, 1);
                if(r.players.length === 0) delete rooms[rid];
                else if(r.status === 'playing') { io.to(rid).emit('error_msg', 'Player disconnected!'); delete rooms[rid]; } 
                else updateLobby(rid);
            }
        }
    });
});

function updateLobby(rid) { if(rooms[rid]) io.to(rid).emit('update_lobby', { players: rooms[rid].players, colors: COLORS }); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));