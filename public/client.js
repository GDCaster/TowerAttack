const socket = io();
let roomId = null;
let myId = null;
let selectionMode = null; // เก็บท่าที่กดรอเลือกเป้าหมาย

// Navigation
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// Menu & Lobby
function createRoom() {
    const u = document.getElementById('username').value;
    const r = document.getElementById('room-id').value;
    if(u && r) socket.emit('createRoom', { roomId: r, username: u });
}
function joinRoom() {
    const u = document.getElementById('username').value;
    const r = document.getElementById('room-id').value;
    if(u && r) socket.emit('joinRoom', { roomId: r, username: u });
}
function toggleReady() { socket.emit('toggleReady', roomId); }
function startGame() { socket.emit('startGame', roomId); }

socket.on('updateLobby', players => {
    document.getElementById('lobby-rid').innerText = roomId;
    const list = document.getElementById('player-list');
    list.innerHTML = players.map(p => `
        <div class="slot ${p.isReady?'ready':''}" style="border-left: 5px solid ${p.color}">
            <b>${p.name}</b> ${p.isHost?'👑':''}
            <span>${p.isReady ? 'พร้อม' : '...'}</span>
        </div>
    `).join('');

    const me = players.find(p=>p.id===socket.id);
    if(me) {
        const rBtn = document.getElementById('ready-btn');
        rBtn.innerText = me.isReady ? "ยกเลิก" : "พร้อม";
        rBtn.className = me.isReady ? "btn btn-gold" : "btn btn-gray";
        
        if(me.isHost) {
            const allReady = players.length >= 2 && players.every(p=>p.isReady);
            const sBtn = document.getElementById('start-btn');
            sBtn.classList.remove('hidden');
            sBtn.disabled = !allReady;
        }
    }
});

socket.on('roomJoined', d => { roomId=d.roomId; myId=socket.id; showScreen('lobby-screen'); });
socket.on('gameStarted', () => showScreen('game-screen'));
socket.on('error', m => alert(m));

// Game Logic
socket.on('updateGame', d => {
    if(d.logs) addLog(d.logs);

    // Render Opponents
    const row = document.getElementById('opponents-row');
    row.innerHTML = d.players.filter(p=>p.id!==myId).map(p => `
        <div class="opp-card ${p.id===d.turnId?'active':''} ${!p.isAlive?'dead':''}" 
             onclick="clickPlayer('${p.id}')" style="border-top:3px solid ${p.color}">
            <div class="opp-name">${p.name}</div>
            <div>💰${p.coins} 🃏${p.cardsCount}</div>
            <div class="graveyard">${p.lostCards.map(c=>`<span class="dead-c">${c[0]}</span>`).join('')}</div>
        </div>
    `).join('');

    // Render Me
    const me = d.players.find(p=>p.id===myId);
    if(me) {
        document.getElementById('my-coins').innerText = me.coins;
        document.getElementById('my-name').innerText = me.name;
        
        const hand = document.getElementById('my-hand');
        // Render Hand (Only updates content to keep toggle state if logic added, but here simple re-render)
        hand.innerHTML = me.cards.map(c => `
            <div class="card" onclick="this.classList.toggle('flipped')">
                <div class="face">${c}</div>
                <div class="back">COUP</div>
            </div>
        `).join('');

        // Action Buttons
        const isTurn = (d.turnId === myId) && me.isAlive;
        document.querySelectorAll('.act-btn').forEach(b => b.disabled = !isTurn);
        document.getElementById('dashboard').style.borderColor = isTurn ? 'var(--gold)' : '#333';
    }
});

// Actions
function doAction(act) { socket.emit('action', { roomId, action: act, targetId: null }); }
function selectMode(act) {
    selectionMode = act;
    document.getElementById('msg-overlay').classList.remove('hidden');
}
function clickPlayer(targetId) {
    if(selectionMode) {
        socket.emit('action', { roomId, action: selectionMode, targetId });
        selectionMode = null;
        document.getElementById('msg-overlay').classList.add('hidden');
    }
}

// Reactions
socket.on('actionBroadcast', d => {
    const ui = document.getElementById('reaction-popup');
    const title = document.getElementById('react-title');
    const desc = document.getElementById('react-desc');
    const btnBlock = document.getElementById('btn-block');
    const btnContessa = document.getElementById('btn-contessa');

    // Reset UI
    ui.classList.remove('hidden');
    btnBlock.style.display = 'inline-block';
    btnContessa.classList.add('hidden');
    
    title.innerText = d.actionNameTH;
    desc.innerText = `${d.sourceName} กำลังใช้ท่านี้...`;

    // Filter Buttons
    if(d.sourceId === myId) {
        ui.classList.add('hidden'); // คนทำท่าไม่ต้องเห็นปุ่ม Reaction
        return;
    }

    if(d.action === 'Income' || d.action === 'Coup') {
        ui.classList.add('hidden'); // ท่าที่ขัดไม่ได้
        return;
    }

    if(d.action === 'Foreign Aid') btnBlock.innerText = "กัน (Duke)";
    if(d.action === 'Steal') btnBlock.innerText = "กัน (Cpt/Amb)";
    
    if(d.action === 'Assassinate') {
        btnBlock.style.display = 'none'; // ใช้ปุ่ม Contessa แทน
        if(d.targetId === myId) {
            btnContessa.classList.remove('hidden');
        }
    }
    if(d.action === 'Tax') btnBlock.style.display = 'none'; // Tax กันไม่ได้ (Challenge ได้อย่างเดียว)

    // Animation
    document.getElementById('timer-fill').style.width = '100%';
    setTimeout(() => document.getElementById('timer-fill').style.width = '0%', 50);
    setTimeout(() => hideReaction(), 5000);
});

socket.on('blockBroadcast', d => {
    // โชว์ UI ให้คนอื่นตัดสินใจว่าจะ Challenge Block ไหม
    const ui = document.getElementById('block-challenge-popup');
    ui.classList.remove('hidden');
    // ซ่อน Reaction ปกติ
    document.getElementById('reaction-popup').classList.add('hidden');
    
    setTimeout(() => ui.classList.add('hidden'), 5000);
});

function sendReact(type) {
    socket.emit('react', { roomId, type });
    hideReaction();
}
function hideReaction() { document.getElementById('reaction-popup').classList.add('hidden'); }
function hideBlockReaction() { document.getElementById('block-challenge-popup').classList.add('hidden'); }

// Modal (Proof / Discard)
socket.on('requestProof', d => showModal(d.message, c => socket.emit('provideProof', {roomId, cardName:c})));
socket.on('forceLoseCard', d => showModal(d.message, c => socket.emit('discardCard', {roomId, cardName:c})));
socket.on('exchangeSelect', d => {
    // Exchange ต้องทิ้ง 2 ใบ (ในที่นี้ทำแบบทิ้งทีละใบเพื่อความง่ายของโค้ด)
    showModal("เลือกการ์ดที่จะทิ้งใบที่ 1 (จาก Exchange)", c1 => {
        socket.emit('discardCard', {roomId, cardName:c1});
        setTimeout(() => {
             // ใบที่ 2 จะถูก Trigger จาก Server เองถ้ายังมีการ์ดเกิน
             showModal("เลือกการ์ดที่จะทิ้งใบที่ 2", c2 => {
                 socket.emit('discardCard', {roomId, cardName:c2});
                 socket.emit('finishExchange', {roomId}); // บอก Server ว่าจบแล้ว
             });
        }, 500);
    }, d.cards); // ส่ง cards ทั้งหมดไปให้เลือก
});

function showModal(msg, callback, overrideCards = null) {
    const m = document.getElementById('card-modal');
    m.classList.remove('hidden');
    document.getElementById('modal-title').innerText = msg;
    const con = document.getElementById('modal-cards');
    
    // ดึงการ์ดจาก UI หรือจากข้อมูลที่ส่งมา
    let cards = [];
    if(overrideCards) {
        cards = overrideCards;
    } else {
        const els = document.querySelectorAll('#my-hand .face');
        els.forEach(e => cards.push(e.innerText));
    }

    con.innerHTML = cards.map(c => `<button class="m-card">${c}</button>`).join('');
    con.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
            m.classList.add('hidden');
            callback(b.innerText);
        }
    });
}

// Chat & Logs
function sendChat() {
    const i = document.getElementById('chat-in');
    if(i.value) { socket.emit('sendChat', {roomId, msg:i.value}); i.value=''; }
}
socket.on('chatMessage', d => {
    const b = document.getElementById('chat-box');
    b.innerHTML += `<div><b>${d.name}:</b> ${d.msg}</div>`;
    b.scrollTop = b.scrollHeight;
});
function addLog(msg) {
    const b = document.getElementById('game-logs');
    b.innerHTML += `<div>${msg}</div>`;
    b.scrollTop = b.scrollHeight;
}