// server.js (example - simplified)
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = 3000; // Or any available port

const db = new sqlite3.Database('road_data.db', (err) => {
  if (err) {
    console.error(err.message);
  }
  console.log('Connected to the database.');
});


app.use(express.json()); // Middleware to parse JSON request bodies

app.post('/api/record', (req, res) => {
  const { latitude, longitude, roughness, timestamp } = req.body;

  db.run(`INSERT INTO records (latitude, longitude, roughness, timestamp) VALUES (?, ?, ?, ?)`, [latitude, longitude, roughness, timestamp], (err) => {
    if (err) {
      console.error(err.message);
      res.status(500).send('Database error');
    } else {
      res.status(201).send('Record saved successfully');
    }
  });
});

app.get('/api/all', (req, res) => {
   db.all("SELECT * FROM records", [], (err, rows) => {
        if (err) {
            console.error(err.message);
            res.status(500).send('Database error');
        } else {
            res.json(rows);
        }
    });
})

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
