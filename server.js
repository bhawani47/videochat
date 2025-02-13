
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pinecone } = require("@pinecone-database/pinecone");
const admin = require("firebase-admin");
const socketIo = require("socket.io");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(require("./firebase-admin-sdk.json")),
  databaseURL: process.env.FIREBASE_DB_URL,
});

// Initialize Pinecone
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pinecone.Index(process.env.PINECONE_INDEX_NAME);

// Track online users with a Map: userId -> Set of socket IDs
const onlineUsers = new Map();

// Start the server
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
const io = socketIo(server, { cors: { origin: "*" } });

const HUGGINGFACE_API_URL =
  "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2";
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

// Function to get embeddings from Hugging Face API


async function getEmbedding(text, retries = 3) {
  if (!text || text.trim() === "") {
    throw new Error("Text input for embedding is empty.");
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(HUGGINGFACE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: text }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log("Full API response:", JSON.stringify(data, null, 2));

      let embedding;
      if (Array.isArray(data)) {
        if (data.length === 384) {
          // Data is a flat array with the correct dimension.
          embedding = data;
        } else if (Array.isArray(data[0]) && data[0].length === 384) {
          // Data is a 2D array.
          embedding = data[0];
        } else if (
          Array.isArray(data[0]) &&
          Array.isArray(data[0][0]) &&
          data[0][0].length === 384
        ) {
          // Data is a 3D array.
          embedding = data[0][0];
        } else {
          console.warn("Unexpected embedding format:", data);
          embedding = data;
        }
      } else {
        throw new Error("Invalid response format");
      }

      console.log("Extracted embedding:", embedding);
      console.log("Embedding length:", embedding.length);

      return embedding;
    } catch (error) {
      console.error(
        `Error generating embedding (Attempt ${attempt}):`,
        error.message
      );
      if (attempt === retries) {
        throw new Error("Embedding generation failed after multiple attempts");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}


// Store user interests in Pinecone
app.post("/store-interests", async (req, res) => {
  const { userId, interests } = req.body;

  if (!userId || !interests) {
    return res.status(400).json({ error: "Missing userId or interests" });
  }

  try {
    const embedding = await getEmbedding(interests);

    console.log(embedding);

    await index.upsert([
      {
        id: userId,
        values: embedding,
        metadata: { 
          interests,
          userId,
          lastUpdated: new Date().toISOString()
        },
      },
    ]);

    res.status(200).json({ message: "Interests stored successfully" });
  } catch (error) {
    console.error("Error storing interests:", error);
    res.status(500).json({ error: "Failed to store interests" });
  }
});

// Find a match based on interests (only return online users)
app.post("/find-match", async (req, res) => {
  const { userId, interests } = req.body;

  if (!userId || !interests) {
    return res.status(400).json({ error: "Missing userId or interests" });
  }

  try {
    console.log(`Finding match for user ${userId} with interests: ${interests}`);
    console.log("Current online users:", Array.from(onlineUsers.keys()));

    const embedding = await getEmbedding(interests);
    
    // Increase topK to improve chances of finding online matches
    const results = await index.query({
      vector: embedding,
      topK: 20, // Increased from 5
      includeMetadata: true,
    });

    console.log("Pinecone results:", results);

    // Filter out self and include only matches that are online
    console.log(`Onloine : ${onlineUsers}`)
    const onlineMatches = results.matches
      .filter((match) => {
        const isOnline = onlineUsers.has(match.metadata.userId);
        const isNotSelf = match.metadata.userId !== userId;
        console.log(
          `Match ${match.metadata.userId}: online=${isOnline}, notSelf=${isNotSelf}`
        );
        return isOnline && isNotSelf;
      })
      .map((match) => ({
        userId: match.metadata.userId,
        interests: match.metadata.interests,
        score: match.score,
      }));

    console.log("Online matches found:", onlineMatches);

    if (onlineMatches.length === 0) {
      return res.status(200).json({ 
        matches: [],
        message: "No online matches found",
        debug: {
          totalResults: results.matches.length,
          onlineUsers: Array.from(onlineUsers.keys())
        }
      });
    }

    res.status(200).json({ matches: onlineMatches });
  } catch (error) {
    console.error("Error finding match:", error);
    res.status(500).json({ error: "Failed to find match" });
  }
});

// WebRTC signaling with Socket.IO
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Register user with their userId
  socket.on("register", (userId) => {
    if (!userId) {
      console.error("Register event received without userId");
      return;
    }

    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);
    socket.userId = userId; // Store userId on the socket for cleanup
    console.log(`User registered: ${userId} (${socket.id})`);
    console.log("Current online users:", Array.from(onlineUsers.keys()));
  });

  // Handle signaling events
  socket.on("offer", (data) => {
    if (!data.targetUserId) {
      console.error("Offer event received without targetUserId");
      return;
    }
    const targetSockets = onlineUsers.get(data.targetUserId);
    if (targetSockets) {
      targetSockets.forEach((targetSocketId) => {
        io.to(targetSocketId).emit("offer", data);
      });
    }
  });

  socket.on("answer", (data) => {
    if (!data.targetUserId) {
      console.error("Answer event received without targetUserId");
      return;
    }
    const targetSockets = onlineUsers.get(data.targetUserId);
    if (targetSockets) {
      targetSockets.forEach((targetSocketId) => {
        io.to(targetSocketId).emit("answer", data);
      });
    }
  });

  socket.on("candidate", (data) => {
    if (!data.targetUserId) {
      console.error("Candidate event received without targetUserId");
      return;
    }
    const targetSockets = onlineUsers.get(data.targetUserId);
    if (targetSockets) {
      targetSockets.forEach((targetSocketId) => {
        io.to(targetSocketId).emit("candidate", data);
      });
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
    if (socket.userId) {
      const userSockets = onlineUsers.get(socket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(socket.userId);
          console.log(`User ${socket.userId} is now offline`);
          console.log("Remaining online users:", Array.from(onlineUsers.keys()));
        }
      }
    }
  });
});

// Test