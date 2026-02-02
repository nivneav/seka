class Deck {
    constructor() {
        this.cards = [];
        this.reset();
    }

    reset() {
        this.cards = [];
        const suits = ['heart', 'diamond', 'club', 'spade'];
        
        // 1. Păstrăm DOAR cărțile de joc (fără 7, 8, 9)
        const ranks = ['10', 'J', 'Q', 'K', 'A'];

        for (let suit of suits) {
            for (let rank of ranks) {
                this.cards.push({ 
                    rank: rank, 
                    suit: suit, 
                    isJoker: false 
                });
            }
        }

        // 2. Adăugăm MANUAL Jokerul (Singurul 7 din joc - cel de Pică)
        this.cards.push({ 
            rank: '7', 
            suit: 'spade', 
            isJoker: true 
        });

        this.shuffle();
    }

    shuffle() {
        // Algoritmul Fisher-Yates
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    deal(count) {
        return this.cards.splice(0, count);
    }
}

module.exports = Deck;
