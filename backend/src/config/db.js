const mysql = require('mysql2');

// Nu mai avem nevoie de dotenv aici pentru Docker, 
// deoarece variabilele sunt injectate direct în container prin docker-compose.
// Totuși, îl păstrăm pentru teste locale (dacă rulezi 'npm start' fără docker).
try {
    require('dotenv').config({ path: '../.env' }); 
} catch (e) { 
    // Ignorăm eroarea dacă .env nu e găsit (în Docker e normal)
}

// Configurația Pool-ului folosind variabilele din docker-compose.yml
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    
    // Aici folosim numele definite în secțiunea 'environment' din docker-compose
    user: process.env.DB_USER || 'root',      
    password: process.env.DB_PASS || '',      
    database: process.env.DB_NAME || 'seka_db',
    
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    
    // Setare importantă pentru a menține conexiunea vie
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

console.log(`🔌 DB Connection Config: Host=${process.env.DB_HOST}, User=${process.env.DB_USER}, DB=${process.env.DB_NAME}`);

// Wrapper pentru a folosi async/await și funcții helper
const db = {
    // 1. Execută interogări SQL standard
    // Ex: await db.query("SELECT * FROM users");
    query: (sql, params) => {
        return pool.promise().query(sql, params);
    },

    // 2. Execută interogări pregătite (mai sigure)
    // Ex: await db.execute("INSERT INTO...", [val1, val2]);
    execute: (sql, params) => {
        return pool.promise().execute(sql, params);
    },

    // 3. Helper pentru Room.js: Obține balanța unui jucător
    getBalance: async (username) => {
        try {
            const [rows] = await pool.promise().execute(
                'SELECT chips FROM users WHERE username = ?', 
                [username]
            );
            return rows[0] ? parseInt(rows[0].chips) : 0;
        } catch (e) {
            console.error(`[DB Error] GetBalance failed for ${username}:`, e.message);
            return 0; // Returnăm 0 în caz de eroare pentru a nu bloca jocul
        }
    },

    // 4. Helper pentru Room.js: Actualizează balanța la final de rundă
    updateBalance: async (username, chips) => {
        try {
            await pool.promise().execute(
                'UPDATE users SET chips = ? WHERE username = ?', 
                [chips, username]
            );
        } catch (e) {
            console.error(`[DB Error] UpdateBalance failed for ${username}:`, e.message);
        }
    }
};

module.exports = db;