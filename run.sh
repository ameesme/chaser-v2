#!/usr/bin/with-contenv bashio

# Parse addon options
export PORT=3000
export CHASER_ARTNET_REFRESH_MS=$(bashio::config 'artnet_refresh_ms')

if bashio::config.true 'debug'; then
    export CHASER_DEBUG=1
    bashio::log.info "Debug mode enabled"
fi

# Initialize data directory with defaults if empty
DATA_DIR="/config/chaser"
mkdir -p "$DATA_DIR"

if [ ! -f "$DATA_DIR/fixtures.json" ]; then
    bashio::log.info "Initializing default configuration files..."
    cp -r /app/data-default/* "$DATA_DIR/"
fi

# Link data directory to app working directory
ln -sf "$DATA_DIR" /app/data

# MQTT Configuration
MQTT_ENABLED=$(bashio::config 'mqtt_enabled')

if bashio::config.true 'mqtt_enabled'; then
    bashio::log.info "MQTT integration enabled"

    MQTT_AUTO=$(bashio::config 'mqtt_auto_configure')

    if bashio::config.true 'mqtt_auto_configure'; then
        # Use Home Assistant MQTT service discovery
        if bashio::services.available "mqtt"; then
            bashio::log.info "Auto-configuring MQTT from Home Assistant service"
            MQTT_HOST=$(bashio::services "mqtt" "host")
            MQTT_PORT=$(bashio::services "mqtt" "port")
            MQTT_USER=$(bashio::services "mqtt" "username")
            MQTT_PASS=$(bashio::services "mqtt" "password")
            MQTT_BROKER="mqtt://${MQTT_HOST}:${MQTT_PORT}"
        else
            bashio::log.warning "MQTT service not available, using manual configuration"
            MQTT_BROKER="mqtt://$(bashio::config 'mqtt_broker'):$(bashio::config 'mqtt_port')"
            MQTT_USER=$(bashio::config 'mqtt_username')
            MQTT_PASS=$(bashio::config 'mqtt_password')
        fi
    else
        # Manual MQTT configuration
        MQTT_BROKER="mqtt://$(bashio::config 'mqtt_broker'):$(bashio::config 'mqtt_port')"
        MQTT_USER=$(bashio::config 'mqtt_username')
        MQTT_PASS=$(bashio::config 'mqtt_password')
    fi

    MQTT_DISCOVERY=$(bashio::config 'mqtt_discovery_prefix')
    MQTT_NODE=$(bashio::config 'mqtt_node_id')

    bashio::log.info "Updating MQTT configuration in environments.json..."

    # Update environments.json with MQTT credentials using jq
    # Find the first MQTT output and update its configuration
    jq --arg broker "$MQTT_BROKER" \
       --arg user "$MQTT_USER" \
       --arg pass "$MQTT_PASS" \
       --arg discovery "$MQTT_DISCOVERY" \
       --arg node "$MQTT_NODE" \
       '.[0].outputs = [.[0].outputs[] |
         if .type == "mqtt" then
           .brokerUrl = $broker |
           .username = $user |
           .password = $pass |
           .discoveryPrefix = $discovery |
           .nodeId = $node |
           .enabled = true
         else .
         end]' \
       "$DATA_DIR/environments.json" > "$DATA_DIR/environments.json.tmp" && \
       mv "$DATA_DIR/environments.json.tmp" "$DATA_DIR/environments.json"

    bashio::log.info "MQTT configured with broker: $MQTT_BROKER"
fi

# Change to app directory (required for relative data/ path resolution)
cd /app

# Log startup information
bashio::log.info "Starting Chaser DMX Sequencer v0.1.0"
bashio::log.info "Web UI available via Home Assistant sidebar (Ingress)"
bashio::log.info "Data directory: ${DATA_DIR}"

# Start the Node.js application
exec node dist/index.js
