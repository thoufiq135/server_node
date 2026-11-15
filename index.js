
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const dotenv = require("dotenv");

dotenv.config();

const dockerRoutes = require("./routes/docker ");
const { initializeDockerMonitor } = require("./services/dockerMonitor");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 2004;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
    origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",")
        : "*"
}));

// HTTP Routes
app.use("/api/docker", dockerRoutes);

app.get("/", (req, res) => {
    res.send("<h1>Stackenzo Server Monitor API</h1>");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "Stackenzo Server Monitor",
        timestamp: new Date().toISOString()
    });
});

// Socket.IO
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN
            ? process.env.CORS_ORIGIN.split(",")
            : "*",
        methods: ["GET", "POST"]
    }
});

io.on("connection", (socket) => {
    console.log("Dashboard connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Dashboard disconnected:", socket.id);
    });
});

// Initialize Docker monitoring
initializeDockerMonitor(io);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Stackenzo Monitor running on port ${PORT}`);
});
