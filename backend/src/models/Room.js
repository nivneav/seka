const Deck = require('./Deck');
const SekaRules = require('./SekaRules'); 
const db = require('../config/db');

class Room {
    constructor(id, name, stake, io) {
        this.id = id;
        this.name = name;
        this.baseStake = parseInt(stake) || 10; 
        this.io = io;
        
        this.players = [];
        this.deck = new Deck();
        
        this.gameState = 'WAITING'; 
        this.gameMode = 'NORMAL'; 
        this.voteMode = null; 
        
        this.pot = 0;             
        this.prevRoundPot = 0;    
        this.current_bet = 0;       
        this.lastBetIsBlind = true; 
        
        this.currentTurnIndex = 0;
        this.dealerUsername = null; 
        this.winnerOfLastRound = null;

        this.currentTurnId = null; 

        this.timers = { turn: null, start: null, vote: null, decision: null };
        this.eligibleForSpecialRound = []; 
        this.svaraWinners = [];
    }

    getPreviousActivePlayer(currentPlayer) {
        if (this.players.length < 2) return null;
        const currentIdx = this.players.indexOf(currentPlayer);
        let checkIdx = currentIdx;
        let loopCount = 0;
        do {
            checkIdx = (checkIdx - 1 + this.players.length) % this.players.length;
            const p = this.players[checkIdx];
            if (!p.isFolded && !p.isSpectator) return p;
            loopCount++;
        } while (loopCount < this.players.length);
        return null;
    }

    calculateCallAmount(player) {
        if (!player || player.isFolded || player.isSpectator) return 0;
        const activePlayers = this.players.filter(p => !p.isFolded && !p.isSpectator);
        const isFirstPlayer = activePlayers.every(p => p.currentBet === 0);
        if (isFirstPlayer) return this.baseStake;

        const last_bet = this.current_bet;
        const previous_is_blind = this.lastBetIsBlind;
        const player_is_blind = !player.hasSeenCards;

        if (previous_is_blind) {
            return player_is_blind ? last_bet : last_bet * 2;
        } else {
            if (player_is_blind) {
                let half = Math.ceil(last_bet / 2);
                return half < this.baseStake ? this.baseStake : half;
            } else {
                return last_bet;
            }
        }
    }

    getPublicState() {
        const activeCount = this.players.filter(p => !p.isFolded && !p.isSpectator && p.isOnline).length;
        return {
            id: this.id,
            name: this.name,
            stake: this.baseStake,
            gameState: this.gameState,
            gameMode: this.gameMode,
            voteMode: (this.gameState === 'VOTING') ? this.voteMode : null,
            pot: this.pot + (this.prevRoundPot || 0),
            dealer: this.dealerUsername,
            winner: this.winnerOfLastRound,
            currentTurn: (this.gameState === 'ACTIVE' && this.players[this.currentTurnIndex]) ? this.players[this.currentTurnIndex].username : null,
            canShowdown: activeCount === 2,
            players: this.players.map(p => ({
                username: p.username,
                chips: p.chips,
                currentBet: p.currentBet, 
                isFolded: p.isFolded,
                isSpectator: p.isSpectator,
                hasSeenCards: p.hasSeenCards,
                isOnline: p.isOnline,
                hasActed: p.hasActed,
                voteStatus: this.gameState === 'VOTING' ? p.voteStatus : null,
                callAmount: (this.gameState === 'ACTIVE' && !p.isFolded && !p.isSpectator) ? this.calculateCallAmount(p) : 0
            }))
        };
    }

    broadcastState() {
        // FIX: Folosim String(this.id) pentru consistență
        this.io.to(String(this.id)).emit('game_state', this.getPublicState());
        this.io.emit('lobby_update_count', { roomId: this.id, count: this.players.length });
    }

    async addPlayer(user, socketId) {
        let existing = this.players.find(p => p.username === user.username);
        if (existing) {
            existing.socketId = socketId; 
            existing.isOnline = true;
            this.broadcastState();
            if (['ACTIVE', 'SHOWDOWN', 'VOTING', 'WINNER_DECISION'].includes(this.gameState) && !existing.isFolded) {
                this.io.to(socketId).emit('your_cards', existing.hand);
            }
            return { success: true, isReconnect: true, player: existing };
        }

        if (this.players.length >= 7) return { success: false, msg: "Masa este plină!" };
        let chips = await db.getBalance(user.username);
        if (chips < this.baseStake * 5) return { success: false, msg: `Minim ${this.baseStake * 5} chips!` };

        const isSpectator = (this.gameState !== 'WAITING');
        const p = { 
            socketId, username: user.username, chips: chips, hand: [], currentBet: 0, 
            isFolded: false, hasSeenCards: false, hasActed: false, isOnline: true, 
            isSpectator: isSpectator, voteStatus: null, serverScore: 0
        };
        this.players.push(p);
        if (this.players.length === 1) this.dealerUsername = user.username;
        
        this.broadcastState();
        this.checkStart();
        return { success: true, isReconnect: false };
    }

    removePlayer(socketId) {
        const idx = this.players.findIndex(p => p.socketId === socketId);
        if (idx !== -1) {
            const p = this.players[idx];
            if (this.gameState === 'ACTIVE' && !p.isFolded && !p.isSpectator) this.handleFold(p, true);
            this.players.splice(idx, 1);
            this.broadcastState();
            if (this.players.length < 2 && this.gameState !== 'WAITING') this.resetToWaiting();
        }
    }

    checkStart() {
        if (this.gameState !== 'WAITING') return;
        const readyPlayers = this.players.filter(p => p.isOnline && p.chips >= this.baseStake);
        if (readyPlayers.length >= 2 && !this.timers.start) {
            this.io.to(String(this.id)).emit('msg_system', 'Jocul începe în 3 secunde...');
            this.timers.start = setTimeout(() => { this.startGame('NORMAL'); this.timers.start = null; }, 3000);
        }
    }
    
    resetToWaiting() {
        this.gameState = 'WAITING';
        this.pot = 0; this.prevRoundPot = 0;
        clearTimeout(this.timers.turn); clearTimeout(this.timers.vote); clearTimeout(this.timers.decision); clearTimeout(this.timers.start);
        this.timers.start = null; this.currentTurnId = null;
        this.broadcastState();
    }

    startGame(type='NORMAL') {
        if(this.timers.turn) clearTimeout(this.timers.turn);
        if(this.timers.vote) clearTimeout(this.timers.vote);
        if(this.timers.decision) clearTimeout(this.timers.decision);

        this.gameState = 'ACTIVE'; 
        this.gameMode = type; 
        this.deck = new Deck(); 
        this.deck.shuffle();
        
        this.pot = (type === 'SVARA' || type === 'SAMOVAR') ? this.prevRoundPot : 0; 
        this.prevRoundPot = 0;
        this.current_bet = this.baseStake; 
        this.lastBetIsBlind = true; 
        
        this.players.forEach(p => {
            p.hand = []; 
            p.isFolded = false; 
            p.hasSeenCards = false; 
            p.hasActed = false; 
            p.currentBet = 0; 
            p.voteStatus = null;
            p.serverScore = 0;
            
            if (p.isOnline && p.chips >= this.baseStake) {
                if (type === 'NORMAL') {
                    p.isSpectator = false; p.chips -= this.baseStake; this.pot += this.baseStake; 
                } else { 
                    p.isSpectator = !this.eligibleForSpecialRound.includes(p.username); 
                }
            } else { p.isSpectator = true; }
        });

        const active = this.players.filter(p => !p.isSpectator);
        if (active.length < 2) { this.resetToWaiting(); return; }

        let dIdx = active.findIndex(p => p.username === this.dealerUsername); 
        if(dIdx === -1) dIdx = 0; 
        this.dealerUsername = active[(dIdx + 1) % active.length].username;
        const firstTurnPlayer = active[(dIdx + 2) % active.length];
        this.currentTurnIndex = this.players.indexOf(firstTurnPlayer);

        for(let r = 0; r < 3; r++) active.forEach(p => p.hand.push(this.deck.deal(1)[0]));
        active.forEach(p => p.serverScore = SekaRules.calculateScore(p.hand));
        
        // FIX: String ID
        this.io.to(String(this.id)).emit('animate_deal', { dealer: this.dealerUsername });
        
        const animationDelay = 1000 + (active.length * 600);
        setTimeout(() => { this.startTurnTimer(); this.broadcastState(); }, animationDelay);
    }

    nextTurn() {
        let loop = 0; 
        do { 
            this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length; 
            loop++; 
        } while((this.players[this.currentTurnIndex].isFolded || this.players[this.currentTurnIndex].isSpectator || !this.players[this.currentTurnIndex].isOnline) && loop < this.players.length);
        this.startTurnTimer(); this.broadcastState();
    }

    startTurnTimer() { 
        if(this.timers.turn) clearTimeout(this.timers.turn); 
        const c = this.players[this.currentTurnIndex]; 
        if(!c) return; 
        const turnId = Date.now(); this.currentTurnId = turnId;
        this.timers.turn = setTimeout(() => {
            if (this.currentTurnId !== turnId) return;
            this.handleFold(c, true);
        }, 15000); 
    }

    handleAction(socketId, action, data) {
        const p = this.players.find(p => p.socketId === socketId);
        if (!p) return;

        if (action === 'LEAVE') { this.removePlayer(socketId); this.io.to(socketId).emit('left_room_success'); return; }
        
        if (action === 'SEE_CARDS') {
            if (p.isFolded || p.isSpectator) return;
            if (!p.hasSeenCards) {
                p.hasSeenCards = true;
                this.io.to(socketId).emit('your_cards', p.hand);
                this.broadcastState();
            }
            return;
        }

        if (this.gameState === 'WINNER_DECISION') {
            if (p.username === this.winnerOfLastRound) {
                if (action === 'FLEX') { 
                    this.io.to(String(this.id)).emit('showdown_reveal', { username: p.username, hand: p.hand, score: p.serverScore });
                    if(this.timers.decision) clearTimeout(this.timers.decision);
                    setTimeout(() => this.startGame('NORMAL'), 5000); 
                } else if (action === 'INIT_SAMOVAR') { 
                    if(this.timers.decision) clearTimeout(this.timers.decision);
                    this.startVotingPhase('SAMOVAR'); 
                }
            }
            return;
        }

        if (this.gameState === 'VOTING' && action === 'VOTE') { this.processVote(p, data.vote); return; }

        if (this.gameState !== 'ACTIVE' || this.players[this.currentTurnIndex] !== p) return;
        this.currentTurnId = null; if (this.timers.turn) clearTimeout(this.timers.turn);

        if (action === 'FOLD') { this.handleFold(p); }
        else if (action === 'BET') {
            let amount = parseInt(data.amount) || 0;
            if (p.chips < amount) { this.io.to(p.socketId).emit('msg_error', 'Fonduri insuficiente!'); this.startTurnTimer(); return; }
            p.chips -= amount; this.pot += amount;
            this.current_bet = amount; this.lastBetIsBlind = !p.hasSeenCards;
            p.currentBet = amount; p.hasActed = true;
            const type = amount > this.baseStake * 2 ? 'raise' : 'call';
            
            // FIX: String ID pentru action_anim
            this.io.to(String(this.id)).emit('action_anim', { type: type, username: p.username, amount });
            
            this.nextTurn();
        }
        else if (action === 'SHOWDOWN') {
            const cost = this.calculateCallAmount(p);
            if (cost > 0) {
                if (p.chips < cost) { this.io.to(p.socketId).emit('msg_error', 'Fără bani pt Showdown!'); this.startTurnTimer(); return; }
                p.chips -= cost; this.pot += cost;
                // FIX: String ID
                this.io.to(String(this.id)).emit('action_anim', { type: 'call', username: p.username, amount: cost });
            }
            this.triggerShowdown();
        }
        else if (action === 'OPEN_PREVIOUS') { this.handleOpenPrevious(p); }
    }

    handleFold(p, forced=false) { 
        p.isFolded = true; 
        // FIX: String ID - Aceasta era problema principală cu animația de fold
        this.io.to(String(this.id)).emit('action_anim', { type: 'fold', username: p.username }); 
        
        const active = this.players.filter(pl => !pl.isFolded && !pl.isSpectator); 
        if (active.length === 1) this.endRound(active[0]); 
        else if (!forced) this.nextTurn(); 
        else { if(active.length === 1) this.endRound(active[0]); else this.nextTurn(); }
    }
    
    handleOpenPrevious(c) { 
        const p = this.getPreviousActivePlayer(c); 
        if(!p || !p.hasSeenCards) { this.io.to(c.socketId).emit('msg_error','Nu poți vedea cărțile!'); this.startTurnTimer(); return; } 
        const cost = this.calculateCallAmount(c); 
        if(c.chips < cost) { this.io.to(c.socketId).emit('msg_error','Nu ai bani!'); this.startTurnTimer(); return; }
        c.chips -= cost; this.pot += cost; 
        
        // FIX: String ID
        this.io.to(String(this.id)).emit('action_anim',{ type:'call', username:c.username, amount:cost }); 
        
        this.io.to(c.socketId).emit('reveal_single_hand', { username: p.username, hand: p.hand }); 
        setTimeout(() => {
            if (this.gameState !== 'ACTIVE') return; 
            if (c.serverScore > p.serverScore) { 
                // FIX: handleFold face deja nextTurn, nu trebuie apelat din nou
                this.handleFold(p, true); 
            } 
            else { 
                this.handleFold(c); 
            }
        }, 2500); 
    }

    triggerShowdown() { 
        console.log(`[ROOM ${this.id}] SHOWDOWN TRIGGERED`);
        this.gameState = 'SHOWDOWN'; 
        this.broadcastState(); 

        const active = this.players.filter(p => !p.isFolded && !p.isSpectator); 
        active.forEach(p => {
            this.io.to(String(this.id)).emit('showdown_reveal', { username: p.username, hand: p.hand, score: p.serverScore }); 
        }); 
        
        let max = -1, winners = []; 
        active.forEach(p => {
            if(p.serverScore > max) { max = p.serverScore; winners = [p]; }
            else if(p.serverScore === max) winners.push(p);
        }); 
        setTimeout(() => {
            if (winners.length > 1) this.handleSvara(winners); 
            else this.endRound(winners[0]);
        }, 4000); 
    }

    handleSvara(winners) { 
        this.io.to(String(this.id)).emit('msg_system', 'SVARA! Pot-ul se reportează.'); 
        this.prevRoundPot = this.pot; this.pot = 0; 
        this.eligibleForSpecialRound = this.players.filter(p => !p.isSpectator).map(p => p.username);
        this.svaraWinners = winners.map(p => p.username); 
        this.startVotingPhase('SVARA'); 
    }

    async endRound(w) { 
        this.winnerOfLastRound = w.username; 
        this.dealerUsername = w.username; 
        this.gameState = 'WINNER_DECISION'; 
        this.prevRoundPot = this.pot + (this.prevRoundPot || 0); this.pot = 0; 
        // FIX: String ID
        this.io.to(String(this.id)).emit('round_winner', { winner: w.username, amount: this.prevRoundPot }); 
        this.broadcastState(); 
        this.timers.decision = setTimeout(() => { 
            if (this.gameState === 'WINNER_DECISION') { 
                w.chips += this.prevRoundPot; db.updateBalance(w.username, w.chips); 
                this.prevRoundPot = 0; this.startGame('NORMAL'); 
            } 
        }, 8000); 
    }

    startVotingPhase(mode) {
        if(this.timers.turn) clearTimeout(this.timers.turn);
        if(this.timers.decision) clearTimeout(this.timers.decision);

        this.gameState = 'VOTING'; 
        this.voteMode = mode;
        this.players.forEach(p => p.voteStatus = null);

        if (mode === 'SAMOVAR') {
            this.eligibleForSpecialRound = this.players.filter(p => !p.isSpectator && p.chips >= this.prevRoundPot/2).map(p => p.username);
            const initiator = this.players.find(p => p.username === this.winnerOfLastRound);
            if(initiator) initiator.voteStatus = 'YES';
        } 
        else if (mode === 'SVARA') {
            this.svaraWinners.forEach(name => {
               const p = this.players.find(pl => pl.username === name);
               if(p) p.voteStatus = 'YES';
            });
        }

        this.broadcastState();
        this.io.to(String(this.id)).emit('msg_system', `Votare ${mode} (10s)`);
        this.timers.vote = setTimeout(() => this.finalizeVoting(mode), 10000);
        this.checkIfAllVoted();
    }

    processVote(p, vote) {
        if (p.isSpectator || !this.eligibleForSpecialRound.includes(p.username)) return;
        p.voteStatus = vote;
        this.broadcastState();
        this.checkIfAllVoted();
    }

    checkIfAllVoted() {
        const eligibleObj = this.players.filter(p => this.eligibleForSpecialRound.includes(p.username));
        const allDone = eligibleObj.every(p => p.voteStatus !== null);
        if (allDone && eligibleObj.length > 0) {
            if(this.timers.vote) clearTimeout(this.timers.vote);
            this.finalizeVoting(this.voteMode);
        }
    }

    finalizeVoting(mode) {
        if(this.timers.vote) clearTimeout(this.timers.vote);
        const yesVoters = this.players.filter(p => p.voteStatus === 'YES' && this.eligibleForSpecialRound.includes(p.username));

        if (yesVoters.length < 2) {
            if (mode === 'SVARA') {
                if (this.svaraWinners.length > 0) {
                    const split = Math.floor(this.prevRoundPot / this.svaraWinners.length);
                    this.players.forEach(p => { if (this.svaraWinners.includes(p.username)) { p.chips += split; db.updateBalance(p.username, p.chips); }});
                }
            } else {
                const winner = this.players.find(p => p.username === this.winnerOfLastRound);
                if (winner) { winner.chips += this.prevRoundPot; db.updateBalance(winner.username, winner.chips); }
            }
            this.prevRoundPot = 0; this.startGame('NORMAL'); 
            return;
        }

        let potAdded = 0; let confirmedPlayers = [];
        yesVoters.forEach(p => {
            const isFree = (mode === 'SVARA' && this.svaraWinners.includes(p.username)) || (mode === 'SAMOVAR' && p.username === this.winnerOfLastRound);
            if (isFree) { confirmedPlayers.push(p.username); } 
            else {
                let cost = Math.ceil(this.prevRoundPot / 2);
                if (p.chips >= cost) { p.chips -= cost; potAdded += cost; confirmedPlayers.push(p.username); } 
                else { p.voteStatus = 'NO'; this.io.to(p.socketId).emit('msg_error', 'Fără bani de intrare!'); }
            }
        });

        if (confirmedPlayers.length < 2) { this.prevRoundPot += potAdded; this.startGame('NORMAL'); return; }
        this.eligibleForSpecialRound = confirmedPlayers;
        this.prevRoundPot += potAdded; this.pot = 0; 
        this.startGame(mode);
    }
}
module.exports = Room;