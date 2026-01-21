const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// --- COUP CONFIG ---
const ROLES = ["Duke", "Assassin", "Ambassador", "Captain", "Contessa"];
// สีสำหรับให้เลือก (เอามาจาก Battle War)
const COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#3742fa', 
    '#2f3542', '#8e44ad', '#e84393', '#00d2d3', '#fff200'
];

class Room {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.status = 'waiting'; // waiting, playing
        this.turnIndex = 0;
        this.direction = 1; 
        this.deck = [];
        
        // Timer Variables
        this.turnTimer = null;
        this.actionTimer = null;
        this.currentAction = null; 
    }
}

const rooms = {};

// --- UTILS ---
function createDeck() {
    let deck = [];
    for (let r of ROLES) for (let i = 0; i < 3; i++) deck.push(r);
    return deck.sort(() => Math.random() - 0.5);
}

function nextTurn(room) {
    if (!room || room.players.length === 0) return;
    clearTimeout(room.turnTimer);
    clearTimeout(room.actionTimer);

    room.currentAction = null;
    
    // Check Win
    const alive = room.players.filter(p => p.isAlive);
    if (alive.length === 1) {
        io.to(room.id).emit('gameOver', { winner: alive[0].name });
        room.status = 'finished';
        return;
    }

    // Find next alive player
    let idx = room.turnIndex;
    let loop = 0;
    do {
        idx = (idx + room.direction + room.players.length) % room.players.length;
        loop++;
    } while (!room.players[idx].isAlive && loop < room.players.length);
    
    room.turnIndex = idx;
    const currentPlayer = room.players[room.turnIndex];

    updateGame(room, `>> ตาของ ${currentPlayer.name}`);
    
    // Auto Turn skip if AFK (45s)
    room.turnTimer = setTimeout(() => {
        if(room.status === 'playing' && !room.currentAction) {
            io.to(room.id).emit('updateGame', { logs: `${currentPlayer.name} หมดเวลา! (บังคับหยิบเหรียญ)` });
            processAction(room, currentPlayer.id, 'Income', null);
        }
    }, 45000);
}

function updateGame(room, logMsg = null) {
    if(!room) return;
    const currP = room.players[room.turnIndex];
    io.to(room.id).emit('updateGame', {
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            coins: p.coins,
            cardsCount: p.cards.length,
            isAlive: p.isAlive,
            lostCards: p.lostCards || [],
            cards: p.isAlive ? p.cards : [],
            color: p.color
        })),
        turnId: currP ? currP.id : null,
        deckCount: room.deck.length,
        logs: logMsg
    });
}

function loseCard(room, playerId, reason) {
    const p = room.players.find(x => x.id === playerId);
    if (!p || !p.isAlive) return;

    if (p.cards.length > 0) {
        io.to(playerId).emit('forceLoseCard', { message: `คุณต้องทิ้งการ์ด 1 ใบ (${reason})` });
    } else {
        p.isAlive = false;
        updateGame(room, `${p.name} ถูกกำจัดออกจากเกม!`);
        nextTurn(room);
    }
}

// --- ACTION LOGIC (เดิมของ Coup) ---
function processAction(room, playerId, actionType, targetId) {
    const player = room.players.find(p => p.id === playerId);
    clearTimeout(room.turnTimer);

    if (actionType === 'Income') { 
        player.coins++;
        updateGame(room, `${player.name} หยิบ 1 เหรียญ`);
        nextTurn(room);
        return;
    }
    
    if (actionType === 'Coup') { 
        if (player.coins < 7) return;
        player.coins -= 7;
        updateGame(room, `${player.name} รัฐประหารใส่เป้าหมาย!`);
        room.currentAction = { type: 'Coup', sourceId: playerId, targetId: targetId };
        loseCard(room, targetId, "โดนรัฐประหาร");
        return;
    }

    let cost = 0;
    if (actionType === 'Assassinate') cost = 3;
    if (player.coins < cost) return;
    player.coins -= cost;

    room.currentAction = { 
        type: actionType, sourceId: playerId, targetId: targetId, status: 'pending', cost: cost
    };

    const thaiNames = {
        'Foreign Aid': 'ขอเงินช่วยเหลือ (2)',
        'Tax': 'เก็บภาษี (3)',
        'Steal': 'ขโมยเหรียญ',
        'Assassinate': 'ลอบสังหาร',
        'Exchange': 'เปลี่ยนการ์ด'
    };

    io.to(room.id).emit('actionBroadcast', {
        action: actionType,
        actionNameTH: thaiNames[actionType],
        sourceName: player.name,
        sourceId: player.id,
        targetId: targetId
    });

    room.actionTimer = setTimeout(() => {
        resolveAction(room);
    }, 8000); // ให้เวลาตัดสินใจ 8 วิ
}

function resolveAction(room) {
    const act = room.currentAction;
    if (!act) return;

    const source = room.players.find(p => p.id === act.sourceId);
    const target = act.targetId ? room.players.find(p => p.id === act.targetId) : null;
    let msg = "";

    if (act.type === 'Foreign Aid') {
        source.coins += 2; msg = `${source.name} ได้รับเงินช่วยเหลือ (+2)`;
    } else if (act.type === 'Tax') {
        source.coins += 3; msg = `${source.name} เก็บภาษี (+3)`;
    } else if (act.type === 'Steal') {
        const stolen = Math.min(target.coins, 2);
        target.coins -= stolen; source.coins += stolen;
        msg = `${source.name} ขโมย ${stolen} เหรียญจาก ${target.name}`;
    } else if (act.type === 'Assassinate') {
        msg = `${source.name} ลอบสังหารสำเร็จ!`;
        updateGame(room, msg);
        loseCard(room, target.id, "โดนลอบสังหาร");
        return;
    } else if (act.type === 'Exchange') {
        msg = `${source.name} ทำการเปลี่ยนการ์ด`;
        if (room.deck.length >= 2) {
            const drawn = [room.deck.pop(), room.deck.pop()];
            source.cards.push(...drawn);
            io.to(source.id).emit('exchangeSelect', { cards: source.cards });
            updateGame(room, msg);
            return;
        }
    }

    updateGame(room, msg);
    nextTurn(room);
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    
    // --- LOBBY SYSTEM (BATTLE WAR STYLE) ---
    socket.on('create_room', ({ name, customId }) => {
        let roomId;
        if (customId && customId.trim() !== "") {
            roomId = customId.trim().toUpperCase();
            if (rooms[roomId]) return socket.emit('error_msg', 'ชื่อห้องซ้ำ');
        } else {
            roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
        }

        rooms[roomId] = new Room(roomId);
        joinRoomLogic(socket, roomId, name, true);
    });

    socket.on('join_room', ({ roomId, name }) => {
        const id = roomId.trim().toUpperCase();
        const room = rooms[id];
        if(!room) return socket.emit('error_msg', 'ไม่พบห้อง');
        if(room.players.length >= 6) return socket.emit('error_msg', 'ห้องเต็ม (Max 6)');
        if(room.status === 'playing') return socket.emit('error_msg', 'เกมเริ่มแล้ว');
        
        joinRoomLogic(socket, id, name, false);
    });

    function joinRoomLogic(socket, roomId, username, isHost) {
        const room = rooms[roomId];
        socket.join(roomId);
        
        // สุ่มสี
        const usedColors = room.players.map(p => p.color);
        const color = COLORS.find(c => !usedColors.includes(c)) || '#fff';

        room.players.push({ 
            id: socket.id, name: username, coins: 0, cards: [], lostCards: [], 
            isAlive: true, isHost, isReady: false, color 
        });
        
        // ส่งข้อมูลกลับไปแบบ Battle War Protocol
        socket.emit('join_success', { roomId });
        updateLobby(roomId);
    }

    socket.on('select_color', ({ roomId, color }) => {
        const room = rooms[roomId];
        if(!room) return;
        const isTaken = room.players.some(p => p.color === color && p.id !== socket.id);
        if(!isTaken) {
            const p = room.players.find(x => x.id === socket.id);
            if(p) { p.color = color; updateLobby(roomId); }
        }
    });

    socket.on('toggle_ready', (roomId) => {
        const room = rooms[roomId];
        if(room) {
            const p = room.players.find(x => x.id === socket.id);
            if(p) p.isReady = !p.isReady;
            updateLobby(roomId);
        }
    });

    socket.on('start_game_request', (roomId) => {
        const room = rooms[roomId];
        if(!room) return;
        // เช็คเงื่อนไขเริ่มเกม
        if(room.players.length < 2) return socket.emit('error_msg', 'ต้องการอย่างน้อย 2 คน');
        if(!room.players.every(p => p.isReady)) return socket.emit('error_msg', 'ทุกคนต้องกดพร้อม');
        
        // Init Game State
        room.status = 'playing';
        room.deck = createDeck();
        room.players.forEach(p => {
            p.cards = [room.deck.pop(), room.deck.pop()];
            p.coins = 2;
            p.isAlive = true;
            p.lostCards = [];
        });

        io.to(roomId).emit('start_game');
        updateGame(room, "--- เริ่มเกม! ---");
        nextTurn(room);
    });

    function updateLobby(roomId) {
        if(rooms[roomId]) {
            io.to(roomId).emit('update_lobby', { 
                players: rooms[roomId].players,
                colors: COLORS
            });
        }
    }

    // --- GAMEPLAY EVENTS (COUP ORIGINAL) ---
    socket.on('action', ({ roomId, action, targetId }) => {
        const room = rooms[roomId];
        if(!room || room.status !== 'playing') return;
        if(room.players[room.turnIndex].id !== socket.id) return;
        if(room.currentAction) return;
        processAction(room, socket.id, action, targetId);
    });

    socket.on('react', ({ roomId, type }) => {
        const room = rooms[roomId];
        if(!room || !room.currentAction) return;
        clearTimeout(room.actionTimer);

        const reactor = room.players.find(p => p.id === socket.id);
        const actor = room.players.find(p => p.id === room.currentAction.sourceId);
        
        if (type === 'challenge') {
            room.currentAction.status = 'challenging';
            room.currentAction.challengerId = reactor.id;
            io.to(actor.id).emit('requestProof', { 
                action: room.currentAction.type,
                message: `${reactor.name} ท้าจับโกหกคุณ!` 
            });
            updateGame(room, `${reactor.name} ทำการ Challenge!`);
        } else if (type === 'block' || type === 'block_assassin') {
            room.currentAction.status = 'blocking';
            room.currentAction.blockerId = reactor.id;
            io.to(room.id).emit('blockBroadcast', { 
                blockerName: reactor.name, 
                message: `${reactor.name} ทำการ Block!` 
            });
            room.actionTimer = setTimeout(() => {
                updateGame(room, `การ Block สำเร็จ!`);
                if(room.currentAction.type === 'Assassinate') {
                    const src = room.players.find(p => p.id === room.currentAction.sourceId);
                    src.coins += 3;
                }
                nextTurn(room);
            }, 5000);
        } else if (type === 'challenge_block') {
             room.currentAction.status = 'challenging_block';
             const blocker = room.players.find(p => p.id === room.currentAction.blockerId);
             io.to(blocker.id).emit('requestProof', {
                 action: 'Block',
                 message: `${reactor.name} สงสัยการ Block ของคุณ!`
             });
             updateGame(room, `${reactor.name} Challenge การ Block!`);
        }
    });

    socket.on('provideProof', ({ roomId, cardName }) => {
        const room = rooms[roomId];
        if(!room || !room.currentAction) return;
        const actor = room.players.find(p => p.id === socket.id);
        const actType = room.currentAction.type;
        
        let reqCard = [];
        if (room.currentAction.status === 'challenging') {
            if(actType === 'Tax') reqCard = ['Duke'];
            if(actType === 'Steal') reqCard = ['Captain'];
            if(actType === 'Assassinate') reqCard = ['Assassin'];
            if(actType === 'Exchange') reqCard = ['Ambassador'];
        } else if (room.currentAction.status === 'challenging_block') {
             if(actType === 'Foreign Aid') reqCard = ['Duke'];
             if(actType === 'Steal') reqCard = ['Captain', 'Ambassador'];
             if(actType === 'Assassinate') reqCard = ['Contessa'];
        }

        if (!actor.cards.includes(cardName)) return; 
        const isCorrect = reqCard.includes(cardName);
        
        if (isCorrect) {
            // Challenge ผิด (คน Challenge แพ้)
            let loserId = (room.currentAction.status === 'challenging') ? room.currentAction.challengerId : room.currentAction.sourceId; 
            loseCard(room, loserId, "Challenge พลาด");

            const idx = actor.cards.indexOf(cardName);
            actor.cards.splice(idx, 1);
            room.deck.push(cardName);
            room.deck.sort(() => Math.random() - 0.5);
            actor.cards.push(room.deck.shift());
            
            if (room.currentAction.status === 'challenging') {
                resolveAction(room); 
            } else {
                updateGame(room, "Block สำเร็จ (มีการ์ดจริง)");
                nextTurn(room);
            }
        } else {
            // โกหก (คนโดนจับได้ แพ้)
            loseCard(room, actor.id, "โดนจับโกหกได้");
            if (room.currentAction.status === 'challenging') {
                if(actType === 'Assassinate') {
                     const src = room.players.find(p => p.id === room.currentAction.sourceId);
                     src.coins += 3;
                }
                updateGame(room, "การกระทำล้มเหลว (โกหก)");
                nextTurn(room);
            } else {
                updateGame(room, "Block ล้มเหลว (โกหก)");
                resolveAction(room);
            }
        }
    });

    socket.on('discardCard', ({ roomId, cardName }) => {
        const room = rooms[roomId];
        if(!room) return;
        const p = room.players.find(x => x.id === socket.id);
        const idx = p.cards.indexOf(cardName);
        
        if(idx > -1) {
            p.cards.splice(idx, 1);
            p.lostCards.push(cardName);
            updateGame(room, `${p.name} ทิ้งการ์ด ${cardName}`);

            if(p.cards.length === 0) {
                p.isAlive = false;
                updateGame(room, `${p.name} ถูกกำจัด!`);
            }

            if (room.currentAction && room.currentAction.type === 'Exchange' && room.currentAction.sourceId === p.id) {
               // Exchange Logic handled on client mostly
            } else if(!room.currentAction || (room.currentAction.type === 'Coup' && room.currentAction.targetId === p.id) || (room.currentAction.type === 'Assassinate')) {
                // ถ้าการทิ้งเกิดจากการตาย (Coup/Assassinate/Challenge) ให้ผ่านเทิร์น
                // (ถ้าเกมยังไม่จบ)
                const alive = room.players.filter(pr => pr.isAlive);
                if (alive.length > 1) nextTurn(room);
            }
        }
    });
    
    socket.on('finishExchange', ({roomId}) => {
        const room = rooms[roomId];
        if(room) nextTurn(room);
    });

    socket.on('sendChat', ({ roomId, msg }) => {
        const room = rooms[roomId];
        if(room) {
             const p = room.players.find(player=>player.id===socket.id);
             io.to(roomId).emit('chatMessage', { name: p.name, msg, color: p.color });
        }
    });
    
    socket.on('disconnect', () => {
         for (const rid in rooms) {
             const r = rooms[rid];
             const idx = r.players.findIndex(p => p.id === socket.id);
             if(idx !== -1) {
                 r.players.splice(idx, 1);
                 if(r.players.length === 0) delete rooms[rid];
                 else updateLobby(rid);
             }
         }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Coup Server (Lobby Upgrade) running on ${PORT}`));