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

// ... (keep the getEmbedding function and other endpoints the same) ...

// WebRTC signaling with Socket.IO
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Register user with their userId
  socket.on("register", (userId) => {
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);
    socket.userId = userId;
    console.log(`User registered: ${userId} (${socket.id})`);
  });

  // Handle signaling events
  socket.on("offer", (data) => {
    const targetSockets = onlineUsers.get(data.targetUserId);
    if (targetSockets) {
      targetSockets.forEach(targetSocketId => {
        io.to(targetSocketId).emit("offer", data);
      });
    }
  });

  socket.on("answer", (data) => {
    const targetSockets = onlineUsers.get(data.targetUserId);
    if (targetSockets) {
      targetSockets.forEach(targetSocketId => {
        io.to(targetSocketId).emit("answer", data);
      });
    }
  });

  socket.on("candidate", (data) => {
    const targetSockets = onlineUsers.get(data.targetUserId);
    if (targetSockets) {
      targetSockets.forEach(targetSocketId => {
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
        }
      }
    }
  });
});

// Find a match endpoint (updated filter)
app.post("/find-match", async (req, res) => {
  // ... (keep the existing code) ...
  
  const onlineMatches = results.matches.filter(
    (match) => match.id !== userId && onlineUsers.has(match.id)
  );
  
  // ... (rest of the endpoint code)
});