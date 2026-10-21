

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

require("dotenv").config();

// Import middleware
const security = require("./middleware/security");
const {
  logger,
  morganLogger,
  errorLogger,
  requestLogger,
} = require("./middleware/logging");

// Import routes
const authRoutes = require("./routes/authNew");
const userRoutes = require("./routes/users");
const tripRoutes = require("./routes/trips");
const mapRoutes = require("./routes/maps");
const aiRoutes = require("./routes/ai");

const app = express();
const server = http.createServer(app);

// Trust proxy for deployment platforms such as Render
app.set("trust proxy", 1);

// Configure allowed frontend origins
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

// Add origins configured for deployment
if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .forEach((origin) => allowedOrigins.add(origin));
}

// CORS middleware must run before security middleware and routes
const corsOptions = {
  origin: (origin, callback) => {
    // Requests without an Origin header can include direct health checks.
    // Browser requests with an Origin must match the allowed list.
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }

    logger.warn("CORS origin rejected:", { origin });
    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
  ],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Request logging
app.use(morganLogger);
app.use(requestLogger);

// Security middleware
security(app);

// Compression
app.use(compression());

// Parse request bodies and cookies
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// Make Socket.IO available to routes
const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);

// Socket.IO events
io.on("connection", (socket) => {
  logger.info("User connected:", { socketId: socket.id });

  socket.on("join-trip", (tripId) => {
    socket.join(`trip-${tripId}`);
    logger.info("User joined trip room:", {
      socketId: socket.id,
      tripId,
    });
  });

  socket.on("leave-trip", (tripId) => {
    socket.leave(`trip-${tripId}`);
    logger.info("User left trip room:", {
      socketId: socket.id,
      tripId,
    });
  });

  socket.on("trip-update", (data) => {
    if (data && data.tripId) {
      socket.to(`trip-${data.tripId}`).emit("trip-updated", data);
      logger.info("Trip update broadcasted:", {
        tripId: data.tripId,
        type: data.type,
      });
    }
  });

  socket.on("disconnect", () => {
    logger.info("User disconnected:", { socketId: socket.id });
  });
});

// Static uploaded files
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    setHeaders: (res) => {
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "public, max-age=31536000");
    },
  })
);

// Health check
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "AI Trip Planner API is running",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "1.0.0",
    environment: process.env.NODE_ENV || "development",
  });
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/trips", tripRoutes);
app.use("/api/maps", mapRoutes);
app.use("/api/ai", aiRoutes);

// Error logging and error handler
app.use(errorLogger);

app.use((err, req, res, next) => {
  logger.error("Application error:", {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  if (err.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      success: false,
      message: "This origin is not allowed to access the API.",
    });
  }

  if (err.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message: "Validation error",
      errors: Object.values(err.errors).map((error) => error.message),
    });
  }

  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: "Invalid ID format",
    });
  }

  if (err.code === 11000) {
    return res.status(400).json({
      success: false,
      message: "Duplicate field value",
    });
  }

  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      message: "Token expired",
    });
  }

  return res.status(err.statusCode || 500).json({
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});

// Serve frontend build in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../client/build")));
}

// 404 handler
app.use((req, res) => {
  logger.warn("Route not found:", {
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  if (
    req.originalUrl.startsWith("/api") ||
    process.env.NODE_ENV !== "production"
  ) {
    return res.status(404).json({
      success: false,
      message: "Route not found",
      path: req.originalUrl,
    });
  }

  return res.sendFile(
    path.resolve(__dirname, "../client/build/index.html")
  );
});

// MongoDB connection
const connectDB = async () => {
  const mongoURI =
    process.env.MONGODB_URI_PROD || process.env.MONGODB_URI;

  if (!mongoURI) {
    throw new Error("MongoDB URI not configured");
  }

  const conn = await mongoose.connect(mongoURI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    bufferCommands: false,
  });

  logger.info("MongoDB connected successfully:", {
    host: conn.connection.host,
    database: conn.connection.name,
    readyState: conn.connection.readyState,
  });

  mongoose.connection.on("error", (error) => {
    logger.error("MongoDB connection error:", error);
  });

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
  });

  mongoose.connection.on("reconnected", () => {
    logger.info("MongoDB reconnected");
  });
};

// Graceful shutdown
let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully`);

  server.close();

  try {
    await new Promise((resolve) => io.close(resolve));
    await mongoose.connection.close();
    logger.info("Shutdown completed");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);

  if (process.env.NODE_ENV === "production") {
    gracefulShutdown("unhandledRejection");
  }
});

// Start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();

    server.listen(PORT, () => {
      console.log(`\n🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`🔗 API: http://localhost:${PORT}/api`);
      console.log(`✅ Health: http://localhost:${PORT}/api/health\n`);
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
