class SekaRules {
    static getCardValue(card) {
        if (!card) return 0;
        if (card.isJoker) return 11; 
        const faceValues = { 'A': 11, '10': 10, 'J': 10, 'Q': 10, 'K': 10, '7': 7 };
        return faceValues[card.rank] || 0;
    }

    static calculateScore(hand) {
        if (!Array.isArray(hand) || hand.length !== 3) return 0;

        const joker = hand.find(c => c.isJoker);
        const normalCards = hand.filter(c => !c.isJoker);

        const counts = {};
        let aceCount = 0;
        normalCards.forEach(c => {
            counts[c.rank] = (counts[c.rank] || 0) + 1;
            if (c.rank === 'A') aceCount++;
        });

        // 1️⃣ Doi Ași + Joker = 33
        if (aceCount === 2 && joker) return 33;

        // 2️⃣ Doi Ași + altă carte = 22
        if (aceCount === 2 && !joker) return 22;

        // 3️⃣ Seturi K/Q/J/10
        const setHierarchy = { 'K': 32.5, 'Q': 32.4, 'J': 32.3, '10': 32.2 };
        for (let rank in setHierarchy) {
            if (counts[rank] === 3 || (counts[rank] === 2 && joker)) {
                return setHierarchy[rank];
            }
        }

        // 4️⃣ Suma pe suită (MODIFICATĂ pentru a se potrivi cu Deck.js)
        const suits = ['heart', 'diamond', 'club', 'spade']; // Sincronizat cu Deck.js
        let maxSum = 0;

        for (let suit of suits) {
            const sameSuit = normalCards.filter(c => c.suit === suit);
            if (sameSuit.length === 0) continue;

            let sum = sameSuit.reduce((acc, c) => acc + this.getCardValue(c), 0);

            if (joker) {
                sum += 11; // Jokerul devine As de aceeași culoare
            }

            maxSum = Math.max(maxSum, sum);
        }

        // 5️⃣ Logica pentru Joker fără nicio suită potrivită (mână curcubeu)
        if (joker && maxSum === 0) {
            const normalMax = normalCards.reduce((acc, c) => Math.max(acc, this.getCardValue(c)), 0);
            maxSum = normalMax + 11;
        }

        // 6️⃣ Niciun Joker, nicio suită (mână curcubeu)
        if (!joker && maxSum === 0) {
            maxSum = normalCards.reduce((acc, c) => Math.max(acc, this.getCardValue(c)), 0);
        }

        return maxSum;
    }
}

module.exports = SekaRules;