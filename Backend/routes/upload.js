const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");

const { extractTextFromPDF } = require("../services/pdfProcessor");
const { chunkText } = require("../services/chunker");
const { createEmbedding } = require("../services/embeddingService"); // Gemini API
const VectorChunk = require("../models/VectorChunk");

const router = express.Router();

// Multer memory storage
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

// -------------------------
// Upload PDF & process chunks
// -------------------------
router.post("/file", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "uploads",
    });

    const uploadStream = bucket.openUploadStream(req.file.originalname);
    uploadStream.end(req.file.buffer);

    uploadStream.on("finish", async () => {
      const fileId = uploadStream.id;
      const downloadStream = bucket.openDownloadStream(fileId);
      let buffer = Buffer.alloc(0);
      for await (const chunk of downloadStream) buffer = Buffer.concat([buffer, chunk]);

      const text = await extractTextFromPDF(buffer);
      const chunks = chunkText(text);

      // Embed all chunks sequentially
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await createEmbedding(chunks[i]);
        await VectorChunk.create({
          text: chunks[i],
          embedding,
          source: {
            fileId,
            filename: req.file.originalname,
            page: i + 1,
          },
        });
      }

      res.json({ message: "Success", chunks: chunks.length });
    });

    uploadStream.on("error", err => {
      console.error("GridFS upload failed:", err);
      res.status(500).json({ error: "GridFS upload failed" });
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Processing failed" });
  }
});

// -------------------------
// Query route with top N chunks & context window
// -------------------------
router.post("/query", async (req, res) => {
  const { question, topN = 3 } = req.body;

  if (!question) return res.status(400).json({ error: "Question is required" });

  try {
    const questionEmbedding = await createEmbedding(question);

    // Fetch all chunks (small dataset) or use aggregation for large
    const allChunks = await VectorChunk.find({});

    // Cosine similarity
    const cosineSimilarity = (a, b) => {
      const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
      const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
      return dot / (normA * normB);
    };

    // Compute similarity and sort top N
    const topChunks = allChunks
      .map(c => ({ chunk: c, score: cosineSimilarity(questionEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);

    if (topChunks.length === 0)
      return res.json({ answer: "No relevant chunks found." });

    // Merge text for context window
    const contextText = topChunks.map(c => c.chunk.text).join("\n---\n");

    res.json({
      answer: contextText,
      scores: topChunks.map(c => c.score),
      sources: topChunks.map(c => c.chunk.source),
    });
  } catch (err) {
    console.error("Query failed:", err);
    res.status(500).json({ error: "Query failed" });
  }
});

module.exports = router;
