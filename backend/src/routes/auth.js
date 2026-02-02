const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Importăm conexiunea la MySQL

// --- RUTA: REGISTER (POST /api/auth/register) ---
router.post('/register', async (req, res) => {
    const { username, email, password } = req.body;

    // Validare simplă
    if (!username || !email || !password) {
        return res.status(400).json({ success: false, message: "Toate câmpurile sunt obligatorii!" });
    }

    try {
        // Verificăm dacă userul există deja
        const [existing] = await db.query("SELECT id FROM users WHERE username = ? OR email = ?", [username, email]);
        if (existing.length > 0) {
            return res.status(409).json({ success: false, message: "Username-ul sau Email-ul este deja folosit." });
        }

        // Inserăm utilizatorul (Notă: În producție, parola se criptează cu bcrypt!)
        await db.query("INSERT INTO users (username, email, password, chips) VALUES (?, ?, ?, 10000)", [username, email, password]);
        
        res.json({ success: true, message: "Cont creat cu succes!" });

    } catch (err) {
        console.error("Eroare Register:", err);
        res.status(500).json({ success: false, message: "Eroare server." });
    }
});

// --- RUTA: LOGIN (POST /api/auth/login) ---
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: "Introdu username și parola." });
    }

    try {
        // Căutăm utilizatorul
        const [users] = await db.query("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);

        if (users.length > 0) {
            const user = users[0];
            // Returnăm datele (fără parolă)
            res.json({ 
                success: true, 
                user: { 
                    id: user.id, 
                    username: user.username, 
                    chips: user.chips, 
                    avatar: user.avatar 
                } 
            });
        } else {
            res.status(401).json({ success: false, message: "Username sau parolă incorectă." });
        }

    } catch (err) {
        console.error("Eroare Login:", err);
        res.status(500).json({ success: false, message: "Eroare server." });
    }
});

module.exports = router;