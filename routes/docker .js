const express = require("express");
const Docker = require("dockerode");

const router = express.Router();

const docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock"
});

// GET /api/docker/running
// Returns all currently running containers, grouped by Compose project.
router.get("/running", async (req, res) => {
    try {
        const containers = await docker.listContainers({
            all: false
        });

        const projects = {};

        containers.forEach((container) => {
            const projectName =
                container.Labels?.["com.docker.compose.project"] ||
                "ungrouped";

            if (!projects[projectName]) {
                projects[projectName] = {
                    projectName,
                    containers: []
                };
            }

            projects[projectName].containers.push({
                id: container.Id,
                shortId: container.Id.substring(0, 12),
                name: (container.Names?.[0] || "")
                    .replace(/^\//, ""),
                image: container.Image,
                state: container.State,
                status: container.Status,
                createdAt: new Date(
                    container.Created * 1000
                ).toISOString(),
                ports: container.Ports || [],
                labels: container.Labels || {}
            });
        });

        const projectList = Object.values(projects);

        res.status(200).json({
            success: true,
            totalContainers: containers.length,
            totalProjects: projectList.length,
            projects: projectList
        });

    } catch (error) {
        console.error("Docker running containers error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch running Docker containers",
            error: error.message
        });
    }
});


// GET /api/docker/container/:containerId
// Returns details for one selected container.
router.get("/container/:containerId", async (req, res) => {
    try {
        const { containerId } = req.params;

        if (!containerId || !/^[a-f0-9]{12,64}$/i.test(containerId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid container ID"
            });
        }

        const container = docker.getContainer(containerId);
        const details = await container.inspect();

        res.status(200).json({
            success: true,
            container: {
                id: details.Id,
                name: details.Name.replace(/^\//, ""),
                image: details.Config.Image,
                state: details.State,
                createdAt: details.Created,
                startedAt: details.State.StartedAt,
                restartCount: details.RestartCount,
                project:
                    details.Config.Labels?.[
                        "com.docker.compose.project"
                    ] || "ungrouped"
            }
        });

    } catch (error) {
        console.error("Docker container details error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch container details",
            error: error.message
        });
    }
});

module.exports = router;