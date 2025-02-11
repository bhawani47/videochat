require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const socketIo = require('socket.io');
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(require('./firebase-admin-sdk.json')),
  databaseURL: process.env.FIREBASE_DB_URL,
});

// Initialize Pinecone
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pinecone.Index(process.env.PINECONE_INDEX_NAME);

// Start the server
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const io = socketIo(server, { cors: { origin: '*' } });

// Hugging Face API Configuration using the feature-extraction pipeline
const HUGGINGFACE_API_URL = "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2";
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

/**
 * Generates embeddings using the Hugging Face Inference API.
 * For the "sentence-transformers/all-MiniLM-L6-v2" model, the feature-extraction pipeline
 * accepts a string (or an array of strings) and returns an embedding vector.
 */
async function getEmbedding(text, retries = 3) {
  if (!text || text.trim() === "") {
    throw new Error("Text input for embedding is empty.");
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(HUGGINGFACE_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: text }),
      });

      const rawText = await response.text();

      try {
        const data = JSON.parse(rawText);

        if (response.status === 503) {
          console.log(`Model is still loading... Retrying in 10 seconds (${attempt}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }

        if (!data || data.error) {
          throw new Error(`Error from Hugging Face API: ${JSON.stringify(data)}`);
        }

        return data;
      } catch (jsonError) {
        throw new Error(`Unexpected response from Hugging Face API: ${rawText}`);
      }
    } catch (error) {
      console.error(`Error generating embedding (Attempt ${attempt}):`, error.message);
      if (attempt === retries) {
        throw new Error("Embedding generation failed after multiple attempts");
      }
    }
  }
}

// Store user interests in Pinecone
app.post("/store-interests", async (req, res) => {
  const { sessionId, interests } = req.body;

  if (!sessionId || !interests) {
    return res.status(400).json({ error: "Missing sessionId or interests" });
  }

  try {
    const embedding = await getEmbedding(interests);

    await index.upsert([
      {
        id: sessionId,
        values: embedding,
        metadata: { interests },
      },
    ]);

    res.status(200).json({ message: "Interests stored successfully" });
  } catch (error) {
    console.error("Error storing interests:", error);
    res.status(500).json({ error: "Failed to store interests" });
  }
});

// Find a match based on interests
app.post('/find-match', async (req, res) => {
  const { userId, interests } = req.body;

  if (!userId || !interests) {
    return res.status(400).json({ error: "Missing userId or interests" });
  }

  try {
    const embedding = await getEmbedding(interests);
    const results = await index.query({
      vector: embedding,
      topK: 5,
      includeMetadata: true,
    });
    const matches = results.matches.filter(match => match.id !== userId);
    res.status(200).json({ matches });
  } catch (error) {
    console.error("Error finding match:", error);
    res.status(500).json({ error: "Failed to find match" });
  }
});

// WebRTC signaling with Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('offer', (data) => {
    socket.broadcast.emit('offer', data);
  });

  socket.on('answer', (data) => {
    socket.broadcast.emit('answer', data);
  });

  socket.on('candidate', (data) => {
    socket.broadcast.emit('candidate', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});
