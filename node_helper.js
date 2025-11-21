const NodeHelper = require("node_helper");
const axios = require("axios");

module.exports = NodeHelper.create({
    start: function () {
        this.config = {};
        this.isFetching = false; // Lock-Variable

        setTimeout(() => {
            console.log("MagicMirror is ready. Fetching ShellyPV status...");
            this.fetchShellyPVStatus();
        }, 15000); // Delay to ensure MagicMirror is fully loaded
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;

            if (this.config.shellysPV && Array.isArray(this.config.shellysPV)) {
                console.log("Configuration received, fetching ShellyPV status...");
                this.fetchShellyPVStatus();
            }
        } else if (notification === "GET_SHELLYPV_STATUS") {
            this.fetchShellyPVStatus();
        }
    },

    fetchShellyPVStatus: async function () {
        // Verhindere parallele Ausführungen
        if (this.isFetching) {
            console.log("⚠️ Fetch already in progress, skipping...");
            return;
        }

        this.isFetching = true; // Lock setzen

        const results = [];

        if (!this.config.shellysPV || !Array.isArray(this.config.shellysPV)) {
            console.error("No valid shellysPV configuration found or 'shellysPV' is not an array.");
            this.isFetching = false; // Lock freigeben
            return;
        }

        console.log(`Starting sequential fetch for ${this.config.shellysPV.length} Shelly devices...`);

        try {
            // Sequential statt parallel - nacheinander abfragen
            for (const shellyPV of this.config.shellysPV) {
                let retryCount = 0;
                const maxRetries = 1; // Maximal 1 Retry bei Rate-Limit
                
                while (retryCount <= maxRetries) {
                    try {
                        console.log(`Fetching status for ${shellyPV.name} (ID: ${shellyPV.id})...`);
                        
                        const response = await axios.post(
                            `${this.config.serverUri}/device/status`,
                            `id=${shellyPV.id}&auth_key=${this.config.authKey}`,
                            {
                                timeout: 10000 // 10 second timeout
                            }
                        );

                        const data = response.data?.data?.device_status;

                        if (data) {
                            let isOn = false;
                            let power = null;

                            // Check for Gen 1/2 structure (relay-based devices)
                            if (data.relays) {
                                const channel = parseInt(shellyPV.ch || 0, 10);
                                isOn = data.relays[channel]?.ison || false;
                                power = data.meters?.[channel]?.power || null;
                            }
                            // Check for Gen 3 structure (pm1:0 devices)
                            else if (data["pm1:0"]) {
                                isOn = true; // Assume true if data exists for the device
                                power = data["pm1:0"].apower; // Use 'apower' from pm1:0
                            }
                            // Check for "switch:0" structure
                            else if (data["switch:0"]) {
                                isOn = data["switch:0"].output; // Use 'output' for on/off status
                                power = data["switch:0"].apower; // Use 'apower' for power
                            }
                            // Check for RGB Shelly structure (lights array)
                            else if (data.lights) {
                                const light = data.lights[0]; // Assume single channel for RGB device
                                isOn = light?.ison || false;
                                power = data.meters ? data.meters[0].power : null;
                            }
                            // Check for "em:0" structure EM3 Pro
                            else if (data["em:0"]) {
                                isOn = true; // Use just true for on/off status
                                power = data["em:0"].total_act_power; // Use 'total_act_power' for power
                            }

                            results.push({
                                name: shellyPV.name,
                                isOn: isOn,
                                power: power !== undefined ? power : null,
                                statusClass: isOn ? 'on' : 'off', // Dynamically set status class
                            });
                            
                            console.log(`✓ Successfully fetched ${shellyPV.name}: ${power !== null ? power + 'W' : 'No power data'}, Status: ${isOn ? 'ON' : 'OFF'}`);
                        } else {
                            console.warn(`✗ No device status data received for ${shellyPV.name}`);
                            results.push({
                                name: shellyPV.name,
                                isOn: false,
                                power: null,
                                statusClass: 'off', // Default to off if no data found
                            });
                        }
                        
                        break; // Erfolg - aus der while-Schleife ausbrechen
                        
                    } catch (error) {
                        if (error.response?.status === 429 && retryCount < maxRetries) {
                            console.error(`✗ Rate limit hit for ${shellyPV.name}: Too Many Requests (Retry ${retryCount + 1}/${maxRetries})`);
                            
                            // Längeres Delay und dann Retry
                            console.log("Waiting 11 seconds before retry...");
                            await new Promise(resolve => setTimeout(resolve, 11000));
                            retryCount++;
                            continue; // Nochmal versuchen
                        } else {
                            // Endgültiger Fehler oder andere Fehler
                            if (error.response?.status === 429) {
                                console.error(`✗ Rate limit hit for ${shellyPV.name} - no more retries`);
                            } else {
                                console.error(`✗ Error fetching status for ${shellyPV.name}:`, error.message);
                            }
                            
                            results.push({
                                name: shellyPV.name,
                                isOn: false,
                                power: null,
                                statusClass: 'off', // Default to off on error
                            });
                            break; // Aus der while-Schleife ausbrechen
                        }
                    }
                }
                
                // Normales Delay zwischen den Anfragen (nur wenn nicht das letzte Gerät)
                if (this.config.shellysPV.indexOf(shellyPV) < this.config.shellysPV.length - 1) {
                    console.log("Waiting 3 seconds before next device...");
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            console.log(`✅ Completed fetching all ${results.length} devices. Sending update...`);
            this.sendSocketNotification("SHELLYPV_STATUS_UPDATE", results);
            
        } catch (error) {
            console.error("Unexpected error in fetchShellyPVStatus:", error);
        } finally {
            this.isFetching = false; // Lock immer freigeben
        }
    },
});
