const db = require('../config/db');
const bcrypt = require('bcrypt');

const User = {
    create: async (username, password) => {
        const hash = await bcrypt.hash(password, 10);
        try {
            // 2000 chips bonus de bun venit
            const [res] = await db.execute('INSERT INTO users (username, password_hash, chips) VALUES (?, ?, 2000)', [username, hash]);
            return { success: true, id: res.insertId };
        } catch (e) {
            return { success: false, msg: 'Numele este deja luat.' };
        }
    },

    login: async (username, password) => {
        const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return { success: false, msg: 'Utilizator inexistent.' };
        
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return { success: false, msg: 'Parolă greșită.' };

        // --- Logica Bonus Zilnic ---
        const today = new Date().toISOString().split('T')[0];
        let lastClaim = null;
        
        // Tratăm formatul datei din MySQL
        if(user.last_daily_claim) {
             lastClaim = (typeof user.last_daily_claim === 'string') 
                ? user.last_daily_claim.split('T')[0] 
                : user.last_daily_claim.toISOString().split('T')[0];
        }

        let bonus = 0;
        if (lastClaim !== today) {
            bonus = 1000; // Bonus zilnic
            await db.execute('UPDATE users SET chips = chips + ?, last_daily_claim = ? WHERE id = ?', [bonus, today, user.id]);
            user.chips = parseInt(user.chips) + bonus;
        }

        const { password_hash, ...safeUser } = user;
        return { success: true, user: safeUser, bonus };
    }
};

module.exports = User;
