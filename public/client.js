const socket = io();
let roomId = null;
let myId = null;
let selectionMode = null; 

function toScr(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function createRoom() {
    const name = document.getElementById('pName').value || 'Host';
    const code = document.getElementById('customCode').value;
    socket.emit('create_room', { name, customId: code });
}
function joinRoom() {
    const name = document.getElementById('pName').value || 'Player';
    const code = document.getElementById('customCode').value;
    if(code) socket.emit('join_room', { roomId: code, name });
    else alert("กรุณาใส่รหัสห้อง");
}
function toggleReady() { socket.emit('toggle_ready', roomId); }
function reqStart() { socket.emit('start_game_request', roomId); }

socket.on('join_success', d => {
    roomId = d.roomId;
    toScr('lobbyScreen');
    document.getElementById('room-code').innerText = `ROOM: ${roomId}`;
});
socket.on('error_msg', m => {
    document.getElementById('err-msg').innerText = m;
    setTimeout(()=>document.getElementById('err-msg').innerText='', 3000);
});

socket.on('update_lobby', d => {
    const pal = document.getElementById('color-pal');
    pal.innerHTML = '';
    const me = d.players.find(p => p.id === socket.id);
    if(me) myId = socket.id;

    d.colors.forEach(c => {
        const dot = document.createElement('div');
        dot.className = `c-dot ${me && me.color === c ? 'selected' : ''}`;
        if(d.players.some(p => p.color === c && p.id !== socket.id)) dot.classList.add('taken');
        dot.style.background = c;
        dot.onclick = () => socket.emit('select_color', { roomId, color: c });
        pal.appendChild(dot);
    });

    const list = document.getElementById('player-list');
    list.innerHTML = d.players.map(p => `
        <div class="p-item" style="border-left-color: ${p.color}">
            <b>${p.name} ${p.isHost ? '👑' : ''}</b>
            <span class="p-status ${p.isReady ? 'ready' : ''}">${p.isReady ? 'พร้อม' : 'รอ...'}</span>
        </div>
    `).join('');

    if(me) {
        const rBtn = document.getElementById('ready-btn');
        rBtn.innerText = me.isReady ? "ยกเลิก" : "พร้อม";
        rBtn.className = me.isReady ? "btn btn-gold" : "btn btn-gray";
        
        if(me.isHost) {
            const sBtn = document.getElementById('start-btn');
            sBtn.classList.remove('hidden');
            const allReady = d.players.length >= 2 && d.players.every(p => p.isReady);
            sBtn.disabled = !allReady;
            sBtn.style.opacity = allReady ? 1 : 0.5;
        }
    }
});

socket.on('start_game', () => toScr('gameScreen'));

socket.on('updateGame', d => {
    if(d.logs) addLog(d.logs);
    
    // [FIXED] Force Hide Reaction Popups when turn updates (Auto-resolved)
    hideReaction();
    hideBlockReaction();
    
    const row = document.getElementById('opponents-row');
    row.innerHTML = d.players.filter(p=>p.id!==myId).map(p => `
        <div class="opp-card ${p.id===d.turnId?'turn':''} ${!p.isAlive?'dead':''}" 
             onclick="clickPlayer('${p.id}')" style="border-top-color:${p.color}">
            <div style="font-weight:bold; margin-bottom:5px;">${p.name}</div>
            <div>💰${p.coins} 🃏${p.cardsCount}</div>
            <div style="margin-top:5px; font-size:10px;">${p.lostCards.map(c=>`[${c}]`).join(' ')}</div>
        </div>
    `).join('');

    const me = d.players.find(p=>p.id===myId);
    if(me) {
        document.getElementById('my-coins').innerText = me.coins;
        document.getElementById('my-name').innerText = me.name;
        const hand = document.getElementById('my-hand');
        hand.innerHTML = me.cards.map(c => `
            <div class="card" onclick="this.classList.toggle('hidden-card')"><span>${c}</span></div>
        `).join('');
        const isTurn = (d.turnId === myId) && me.isAlive;
        document.querySelectorAll('.act-btn').forEach(b => b.disabled = !isTurn);
        document.getElementById('dashboard').style.borderColor = isTurn ? 'var(--gold)' : '#333';
    }
});

function doAction(act) { socket.emit('action', { roomId, action: act, targetId: null }); }
function selectMode(act) { selectionMode = act; document.getElementById('select-overlay').classList.remove('hidden'); }
function clickPlayer(targetId) {
    if(selectionMode) {
        socket.emit('action', { roomId, action: selectionMode, targetId });
        selectionMode = null; document.getElementById('select-overlay').classList.add('hidden');
    }
}

socket.on('actionBroadcast', d => {
    if(d.sourceId === myId || d.action === 'Income' || d.action === 'Coup') return;
    const ui = document.getElementById('reaction-popup');
    const btnBlock = document.getElementById('btn-block');
    const btnContessa = document.getElementById('btn-contessa');

    ui.classList.remove('hidden');
    btnBlock.style.display = 'inline-block'; btnContessa.classList.add('hidden');
    document.getElementById('react-title').innerText = d.actionNameTH;
    document.getElementById('react-desc').innerText = `${d.sourceName} กำลังใช้ท่านี้...`;

    if(d.action === 'Foreign Aid') btnBlock.innerText = "กัน (Duke)";
    if(d.action === 'Steal') btnBlock.innerText = "กัน (Captain/Amb)";
    if(d.action === 'Assassinate') { btnBlock.style.display = 'none'; if(d.targetId === myId) btnContessa.classList.remove('hidden'); }
    if(d.action === 'Tax') btnBlock.style.display = 'none';

    const fill = document.getElementById('timer-fill');
    fill.style.transition = 'none'; fill.style.width = '100%';
    setTimeout(() => { fill.style.transition = 'width 8s linear'; fill.style.width = '0%'; }, 50);
});

socket.on('blockBroadcast', d => {
    document.getElementById('reaction-popup').classList.add('hidden');
    document.getElementById('block-challenge-popup').classList.remove('hidden');
});

function sendReact(type) { socket.emit('react', { roomId, type }); hideReaction(); hideBlockReaction(); }
function hideReaction() { document.getElementById('reaction-popup').classList.add('hidden'); }
function hideBlockReaction() { document.getElementById('block-challenge-popup').classList.add('hidden'); }

socket.on('requestProof', d => showModal(d.message, c => socket.emit('provideProof', {roomId, cardName:c})));
socket.on('forceLoseCard', d => showModal(d.message, c => socket.emit('discardCard', {roomId, cardName:c})));
socket.on('exchangeSelect', d => {
    showModal("เลือกการ์ดทิ้งใบที่ 1", c1 => {
        socket.emit('discardCard', {roomId, cardName:c1});
        setTimeout(() => {
             showModal("เลือกการ์ดทิ้งใบที่ 2", c2 => {
                 socket.emit('discardCard', {roomId, cardName:c2});
                 socket.emit('finishExchange', {roomId});
             });
        }, 300);
    }, d.cards);
});

function showModal(msg, callback, overrideCards = null) {
    const m = document.getElementById('card-modal');
    m.classList.remove('hidden');
    document.getElementById('modal-title').innerText = msg;
    const con = document.getElementById('modal-cards');
    let cards = overrideCards || [];
    if(!overrideCards) document.querySelectorAll('#my-hand .card span').forEach(e => cards.push(e.innerText));
    con.innerHTML = cards.map(c => `<button class="modal-btn">${c}</button>`).join('');
    con.querySelectorAll('button').forEach(b => {
        b.onclick = () => { m.classList.add('hidden'); callback(b.innerText); }
    });
}

function sendChat() { const i = document.getElementById('chat-in'); if(i.value) { socket.emit('sendChat', {roomId, msg:i.value}); i.value=''; } }
socket.on('chatMessage', d => {
    const b = document.getElementById('chat-box');
    b.innerHTML += `<div style="color:${d.color}"><b>${d.name}:</b> ${d.msg}</div>`; b.scrollTop = b.scrollHeight;
});
function addLog(msg) { const b = document.getElementById('game-logs'); b.innerHTML = `<div>${msg}</div>` + b.innerHTML; }