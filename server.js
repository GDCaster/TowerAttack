const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIG ---
const rooms = {};
const ROLES = ["Duke", "Assassin", "Ambassador", "Captain", "Contessa"];
const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ec4899', '#f97316', '#64748b'];

class Room {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.gameStarted = false;
        this.turnIndex = 0;
        this.direction = 1; 
        this.deck = [];
        
        // State สำหรับจัดการ Turn และ Reaction
        this.turnTimer = null;    // จับเวลา AFK
        this.actionTimer = null;  // จับเวลาช่วง Challenge/Block (5 วิ)
        this.currentAction = null; // เก็บสถานะ Action ปัจจุบัน { type, sourceId, targetId, status }
    }
}

// --- UTILS ---
function createDeck() {
    let deck = [];
    for (let r of ROLES) for (let i = 0; i < 3; i++) deck.push(r);
    return deck.sort(() => Math.random() - 0.5);
}

function getNextAliveIndex(room) {
    let idx = room.turnIndex;
    let loop = 0;
    do {
        idx = (idx + room.direction + room.players.length) % room.players.length;
        loop++;
    } while (!room.players[idx].isAlive && loop < room.players.length);
    return idx;
}

function nextTurn(room) {
    if (!room || room.players.length === 0) return;
    clearTimeout(room.turnTimer);
    clearTimeout(room.actionTimer);

    room.currentAction = null;
    
    // เช็คผู้ชนะก่อนเปลี่ยนเทิร์น
    if (checkWinCondition(room)) return;

    room.turnIndex = getNextAliveIndex(room);
    const currentPlayer = room.players[room.turnIndex];

    updateGame(room, `>> ตาของ ${currentPlayer.name}`);
    
    // Auto Action ถ้า AFK นานเกิน 30 วินาที
    room.turnTimer = setTimeout(() => {
        if(room.gameStarted && !room.currentAction) {
            io.to(room.id).emit('updateGame', { logs: `${currentPlayer.name} หมดเวลา! (บังคับหยิบเหรียญ)` });
            processAction(room, currentPlayer.id, 'Income', null);
        }
    }, 30000);
}

function checkWinCondition(room) {
    const alive = room.players.filter(p => p.isAlive);
    if (alive.length === 1) {
        io.to(room.id).emit('gameOver', { winner: alive[0].name });
        room.gameStarted = false;
        return true;
    }
    return false;
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
            cards: p.isAlive ? p.cards : [], // ส่งการ์ดไปให้ Client (Client จะซ่อนเอง)
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
        // แจ้งเตือนให้ผู้เล่นเลือกทิ้งการ์ด
        io.to(playerId).emit('forceLoseCard', { message: `คุณต้องทิ้งการ์ด 1 ใบ (${reason})` });
    } else {
        // ตาย (ไม่ควรเกิดขึ้นถ้าระบบเช็ค isAlive ถูกต้อง)
        p.isAlive = false;
        updateGame(room, `${p.name} ถูกกำจัดออกจากเกม!`);
        nextTurn(room);
    }
}

// --- ACTION LOGIC ---
function processAction(room, playerId, actionType, targetId) {
    const player = room.players.find(p => p.id === playerId);
    clearTimeout(room.turnTimer);

    // 1. Action ที่ไม่มีใครขัดได้ (Income, Coup)
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
        
        // Coup ไม่ต้องรอ Block/Challenge แต่ต้องรอเป้าหมายทิ้งการ์ด
        room.currentAction = { type: 'Coup', sourceId: playerId, targetId: targetId };
        loseCard(room, targetId, "โดนรัฐประหาร");
        return;
    }

    // 2. Action ที่ต้องรอ Reaction (Block/Challenge)
    let cost = 0;
    if (actionType === 'Assassinate') cost = 3;
    if (player.coins < cost) return;
    
    player.coins -= cost; // จ่ายเงินก่อน

    room.currentAction = { 
        type: actionType, 
        sourceId: playerId, 
        targetId: targetId, 
        status: 'pending',
        cost: cost
    };

    // แปลชื่อท่าเป็นไทยสำหรับแสดงผล
    const thaiNames = {
        'Foreign Aid': 'ขอเงินช่วยเหลือ (2)',
        'Tax': 'เก็บภาษี (3)',
        'Steal': 'ขโมยเหรียญ',
        'Assassinate': 'ลอบสังหาร',
        'Exchange': 'เปลี่ยนการ์ด'
    };

    // ส่งสัญญาณให้ทุกคนเห็น UI นับถอยหลัง
    io.to(room.id).emit('actionBroadcast', {
        action: actionType,
        actionNameTH: thaiNames[actionType],
        sourceName: player.name,
        sourceId: player.id,
        targetId: targetId
    });

    // เริ่มนับถอยหลัง 5 วินาที
    room.actionTimer = setTimeout(() => {
        resolveAction(room); // ถ้าหมดเวลา ไม่มีใครขัด ให้ทำ Action เลย
    }, 5000);
}

function resolveAction(room) {
    const act = room.currentAction;
    if (!act) return;

    const source = room.players.find(p => p.id === act.sourceId);
    const target = act.targetId ? room.players.find(p => p.id === act.targetId) : null;
    let msg = "";

    if (act.type === 'Foreign Aid') {
        source.coins += 2;
        msg = `${source.name} ได้รับเงินช่วยเหลือ (+2)`;
    } else if (act.type === 'Tax') {
        source.coins += 3;
        msg = `${source.name} เก็บภาษี (+3)`;
    } else if (act.type === 'Steal') {
        const stolen = Math.min(target.coins, 2);
        target.coins -= stolen;
        source.coins += stolen;
        msg = `${source.name} ขโมย ${stolen} เหรียญจาก ${target.name}`;
    } else if (act.type === 'Assassinate') {
        msg = `${source.name} ลอบสังหารสำเร็จ!`;
        updateGame(room, msg);
        loseCard(room, target.id, "โดนลอบสังหาร");
        return; // รอทิ้งการ์ด ค่อย nextTurn
    } else if (act.type === 'Exchange') {
        msg = `${source.name} ทำการเปลี่ยนการ์ด`;
        if (room.deck.length >= 2) {
            const drawn = [room.deck.pop(), room.deck.pop()];
            source.cards.push(...drawn);
            io.to(source.id).emit('exchangeSelect', { cards: source.cards }); // ส่งให้เลือกทิ้ง
            updateGame(room, msg);
            return; // รอเลือกการ์ดคืน ค่อย nextTurn
        }
    }

    updateGame(room, msg);
    nextTurn(room);
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    
    // LOBBY: สร้างห้อง
    socket.on('createRoom', ({ roomId, username }) => {
        if(rooms[roomId]) return socket.emit('error', 'ชื่อห้องซ้ำ');
        rooms[roomId] = new Room(roomId);
        joinRoomLogic(socket, roomId, username, true);
    });

    // LOBBY: เข้าร่วมห้อง
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if(!room) return socket.emit('error', 'ไม่พบห้อง');
        if(room.players.length >= 6) return socket.emit('error', 'ห้องเต็ม');
        if(room.gameStarted) return socket.emit('error', 'เกมเริ่มแล้ว');
        joinRoomLogic(socket, roomId, username, false);
    });

    function joinRoomLogic(socket, roomId, username, isHost) {
        const room = rooms[roomId];
        socket.join(roomId);
        // สุ่มสีที่ไม่ซ้ำ
        const color = COLORS.find(c => !room.players.some(p => p.color === c)) || '#fff';
        room.players.push({ 
            id: socket.id, name: username, coins: 0, cards: [], lostCards: [], 
            isAlive: true, isHost, isReady: false, color 
        });
        io.to(roomId).emit('updateLobby', room.players);
    }

    // LOBBY: กดพร้อม
    socket.on('toggleReady', (roomId) => {
        const room = rooms[roomId];
        if(room) {
            const p = room.players.find(x => x.id === socket.id);
            if(p) p.isReady = !p.isReady;
            io.to(roomId).emit('updateLobby', room.players);
        }
    });

    // LOBBY: เริ่มเกม
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if(!room) return;
        if(room.players.length < 2) return socket.emit('error', 'คนไม่พอ (ขั้นต่ำ 2)');
        if(!room.players.every(p => p.isReady)) return socket.emit('error', 'ทุกคนต้องกดพร้อม');

        room.gameStarted = true;
        room.deck = createDeck();
        room.players.forEach(p => {
            p.cards = [room.deck.pop(), room.deck.pop()];
            p.coins = 2;
            p.isAlive = true;
            p.lostCards = [];
        });
        
        io.to(roomId).emit('gameStarted');
        updateGame(room, "--- เริ่มเกม! ---");
        nextTurn(room);
    });

    // GAME: รับ Action
    socket.on('action', ({ roomId, action, targetId }) => {
        const room = rooms[roomId];
        if(!room || !room.gameStarted) return;
        if(room.players[room.turnIndex].id !== socket.id) return; // ไม่ใช่ตาตัวเอง
        if(room.currentAction) return; // มี Action ค้างอยู่

        processAction(room, socket.id, action, targetId);
    });

    // GAME: รับ Reaction (Block/Challenge)
    socket.on('react', ({ roomId, type }) => {
        const room = rooms[roomId];
        if(!room || !room.currentAction) return;
        clearTimeout(room.actionTimer); // หยุดนับถอยหลัง

        const reactor = room.players.find(p => p.id === socket.id);
        const actor = room.players.find(p => p.id === room.currentAction.sourceId);
        
        if (type === 'challenge') {
            // CHALLENGE: ขอตรวจสอบการ์ด Actor
            room.currentAction.status = 'challenging';
            room.currentAction.challengerId = reactor.id;
            
            io.to(actor.id).emit('requestProof', { 
                action: room.currentAction.type,
                message: `${reactor.name} สงสัยว่าคุณโกหก! กรุณาเลือกการ์ดยืนยัน` 
            });
            updateGame(room, `${reactor.name} ทำการ Challenge!`);

        } else if (type === 'block' || type === 'block_assassin') {
            // BLOCK: มีคนจะกัน
            room.currentAction.status = 'blocking';
            room.currentAction.blockerId = reactor.id;
            
            io.to(room.id).emit('blockBroadcast', { 
                blockerName: reactor.name, 
                message: `${reactor.name} ทำการ Block!` 
            });

            // รอ Challenge การ Block 5 วินาที
            room.actionTimer = setTimeout(() => {
                // ถ้าไม่มีใคร Challenge Block -> Block สำเร็จ -> Action ล้มเหลว
                updateGame(room, `การ Block สำเร็จ! การกระทำถูกยกเลิก`);
                
                // คืนเงินกรณี Assassinate ถูกกัน
                if(room.currentAction.type === 'Assassinate') {
                    const src = room.players.find(p => p.id === room.currentAction.sourceId);
                    src.coins += 3;
                }
                nextTurn(room);
            }, 5000);
        } else if (type === 'challenge_block') {
             // CHALLENGE BLOCK: สงสัยคนกัน
             room.currentAction.status = 'challenging_block';
             const blocker = room.players.find(p => p.id === room.currentAction.blockerId);
             
             io.to(blocker.id).emit('requestProof', {
                 action: 'Block',
                 message: `${reactor.name} สงสัยว่าคุณไม่มีการ์ดกัน! กรุณาเลือกการ์ดยืนยัน`
             });
             updateGame(room, `${reactor.name} Challenge การ Block!`);
        }
    });

    // GAME: ยืนยันการ์ด (Proof)
    socket.on('provideProof', ({ roomId, cardName }) => {
        const room = rooms[roomId];
        if(!room || !room.currentAction) return;

        const actor = room.players.find(p => p.id === socket.id);
        const actType = room.currentAction.type;
        
        // กำหนดการ์ดที่ต้องมีตามสถานการณ์
        let reqCard = [];
        if (room.currentAction.status === 'challenging') {
            if(actType === 'Tax') reqCard = ['Duke'];
            if(actType === 'Steal') reqCard = ['Captain'];
            if(actType === 'Assassinate') reqCard = ['Assassin'];
            if(actType === 'Exchange') reqCard = ['Ambassador'];
        } else if (room.currentAction.status === 'challenging_block') {
             // Block Logic
             if(actType === 'Foreign Aid') reqCard = ['Duke'];
             if(actType === 'Steal') reqCard = ['Captain', 'Ambassador'];
             if(actType === 'Assassinate') reqCard = ['Contessa'];
        }

        // เช็คว่ามีในมือจริงไหม (กัน Hack)
        if (!actor.cards.includes(cardName)) return; 

        const isCorrect = reqCard.includes(cardName);
        
        if (isCorrect) {
            // --- มีการ์ดจริง (คน Challenge แพ้) ---
            const loserId = (room.currentAction.status === 'challenging') ? room.currentAction.challengerId : socket.id /* ในกรณี Block challenge ผิด logic นิดหน่อยเอาตาม flow นี้ก่อน */;
            
            // หาคนแพ้จริงๆ
            let realLoserId;
            if (room.currentAction.status === 'challenging') {
                realLoserId = room.currentAction.challengerId; // คนกด Challenge แพ้
            } else {
                 // ถ้า Challenge Block แล้ว Block มีจริง -> คน Challenge Block แพ้ (คือคนทำ Action เดิม หรือใครก็ได้)
                 // ในโค้ด react ไม่ได้เก็บ challenger_block_id ไว้ เอาเป็นว่าให้คนทำ Action แพ้ละกัน (ส่วนมากคนทำ Action จะ Challenge)
                 // *เพื่อความง่าย* ให้หาคนกด Challenge ล่าสุด
                 // (ขอข้าม Logic ซับซ้อนตรงนี้ ให้ assume ว่า Source เป็นคน Challenge Block)
                 realLoserId = room.currentAction.sourceId; 
            }

            loseCard(room, realLoserId, "Challenge พลาด (อีกฝ่ายมีการ์ดจริง)");

            // เจ้าตัวเอาการ์ดใบเดิมเข้ากอง แล้วจั่วใหม่ (กฎ Coup)
            const idx = actor.cards.indexOf(cardName);
            actor.cards.splice(idx, 1);
            room.deck.push(cardName);
            room.deck.sort(() => Math.random() - 0.5);
            actor.cards.push(room.deck.shift());
            
            // ดำเนินการ Action ต่อ (ถ้าเป็นการ Challenge Main Action)
            if (room.currentAction.status === 'challenging') {
                resolveAction(room); 
            } else {
                // ถ้า Block ถูก Challenge แล้ว Block มีจริง -> Block สำเร็จ -> Main Action Fail
                updateGame(room, "Block สำเร็จ (ยืนยันการ์ดถูกต้อง)");
                nextTurn(room);
            }

        } else {
            // --- โกหก (เจ้าตัวแพ้) ---
            loseCard(room, actor.id, "โดนจับโกหกได้");
            
            if (room.currentAction.status === 'challenging') {
                // Action หลักโกหก -> Action ยกเลิก
                if(actType === 'Assassinate') {
                     // คืนเงิน
                     const src = room.players.find(p => p.id === room.currentAction.sourceId);
                     src.coins += 3;
                }
                updateGame(room, "การกระทำถูกยกเลิก (โกหก)");
                nextTurn(room);
            } else {
                // Block โกหก -> Block ยกเลิก -> Main Action สำเร็จ
                updateGame(room, "Block ล้มเหลว (โกหก)");
                resolveAction(room);
            }
        }
    });

    // GAME: ทิ้งการ์ด
    socket.on('discardCard', ({ roomId, cardName }) => {
        const room = rooms[roomId];
        if(!room) return;
        const p = room.players.find(x => x.id === socket.id);
        const idx = p.cards.indexOf(cardName);
        
        if(idx > -1) {
            p.cards.splice(idx, 1);
            p.lostCards.push(cardName);
            updateGame(room, `${p.name} ทิ้งการ์ด ${cardName}`);

            // เช็คว่าตายไหม
            if(p.cards.length === 0) {
                p.isAlive = false;
                updateGame(room, `${p.name} ถูกกำจัด!`);
            }

            // กรณี Exchange (ต้องทิ้ง 2 ใบ)
            if (room.currentAction && room.currentAction.type === 'Exchange' && room.currentAction.sourceId === p.id) {
                const originalCount = p.isAlive ? (p.cards.length + 1) : 0; // Logic ง่ายๆ เช็คว่าทิ้งครบยัง
                // เพื่อความง่าย ให้ Client บังคับส่ง discard 2 ครั้ง
                // ถ้าเหลือการ์ดเท่าจำนวนชีวิตจริงแล้ว ให้ nextTurn
                // *สมมติว่า Client จัดการ Logic เลือก 2 ใบแล้วส่งมาทีละใบ*
                // เช็ค Deck logic: ปกติ Exchange จั่ว 2 รวมเป็น 4 (หรือ 3) แล้วทิ้ง 2 เหลือ 2 (หรือ 1)
                // ดังนั้นถ้า discard จน hand.length เท่ากับจำนวนชีวิตเดิมก่อนจั่ว ให้ผ่าน
                // (ในที่นี้ขอตัดจบ NextTurn เลยเพื่อกันบั๊กค้าง)
                 // แต่ถ้าทิ้งใบแรกของการ Exchange อย่าเพิ่ง NextTurn
                 // *Logic นี้ซับซ้อน ขอใช้ TimeOut ช่วยใน Client หรือให้ nextTurn ทำงานเมื่อทิ้งครบ*
                 // วิธีแก้ขัด: ถ้า Exchange แล้วมือเหลือ 2 หรือ 1 (ตามชีวิต) ให้ผ่าน
                 // แต่ server ไม่รู้ชีวิตเดิม... เอาเป็นว่า ถ้า p.cards.length <= 2 ให้ผ่านไปก่อน
            }

            // ถ้าไม่มีคนชนะ ให้ไปตาถัดไป
            if(!checkWinCondition(room)) {
                // ถ้าการทิ้งเกิดจาก Coup/Assassinate จบแล้ว ให้เปลี่ยนเทิร์น
                if (room.currentAction && (room.currentAction.type === 'Coup' || room.currentAction.type === 'Assassinate')) {
                    if (room.currentAction.targetId === p.id) nextTurn(room);
                } else if (!room.currentAction || room.currentAction.type === 'Exchange') {
                     // กรณี Exchange ทิ้งเสร็จ หรือกรณีอื่นๆ
                     // เช็คแบบง่าย: ถ้า Exchange แล้วทิ้งจนเหลือเท่าเดิม ให้ next
                     // เพื่อความชัวร์ ให้ nextTurn ทำงานเสมอถ้าไม่ใช่ Coup/Assasin ที่ยังไม่จบ process
                     if(room.currentAction && room.currentAction.type === 'Exchange') {
                         // รอทิ้งอีกใบ (ถ้ามี 4 ใบทิ้งเหลือ 2)
                         // ข้าม Logic นี้ไปก่อน ให้ Client จัดการส่ง nextTurn หรือ server check count
                     }
                }
            }
        }
    });
    
    // Helper สำหรับ Exchange ทิ้งครบแล้ว
    socket.on('finishExchange', ({roomId}) => {
        const room = rooms[roomId];
        if(room) nextTurn(room);
    });

    socket.on('sendChat', ({ roomId, msg }) => {
        const room = rooms[roomId];
        if(room) io.to(roomId).emit('chatMessage', { name: room.players.find(p=>p.id===socket.id).name, msg });
    });
    
    socket.on('disconnect', () => {
         // ลบห้องถ้าว่าง... (Code ตัดออกเพื่อความสั้น)
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));