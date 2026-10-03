# Hardware Architecture & Wiring Diagram

## Component Pinout & Interconnections

### 1. I2C Bus Multiplexing (ESP32)
| ESP32 Pin | ADS1115 (0x48) | PCF8574 LCD (0x27) | Notes |
| :--- | :--- | :--- | :--- |
| **GPIO 21 (SDA)** | `SDA` | `SDA` | Shared I2C Data Line (4.7kΩ pullup) |
| **GPIO 22 (SCL)** | `SCL` | `SCL` | Shared I2C Clock Line (4.7kΩ pullup) |
| **3.3V / 5V** | `VDD` (5V recommended) | `VCC` (5V) | Power rails |
| **GND** | `GND` + `ADDR` (tied to GND) | `GND` | Common ground |

---

### 2. Analog Sensing Channels (Texas Instruments ADS1115)
| ADS1115 Channel | Sensor Assigned | Measurement Role |
| :--- | :--- | :--- |
| **A0** | ACS712-05B #1 OUT | $I_{\text{in}}$: Total Entering Current from Substation |
| **A1** | ACS712-05B #2 OUT | $I_{\text{out}}$: Exiting Current to Zone 2 Downstream |
| **A2** | ACS712-05B #3 OUT | $I_{\text{auth1}}$: House 1 Authorized Consumer Load |
| **A3** | ACS712-05B #4 OUT | $I_{\text{auth2}}$: House 2 Authorized Consumer Load |

---

### 3. Protection & Indicators
| Periph | ESP32 Pin | Logic | Role |
| :--- | :--- | :--- | :--- |
| **Optoisolated Relay** | `GPIO 26` | LOW = CLOSED (Pass) / HIGH = OPEN (Cutoff) | Feeder Segment Disconnect |
| **Theft Indicator LED**| `GPIO 2` | Active HIGH | Flashes during active theft |
