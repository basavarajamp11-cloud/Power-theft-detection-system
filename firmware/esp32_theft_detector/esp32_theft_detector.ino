/**
 * ==============================================================================
 * Project: IoT-Based Power Theft Detection System (KCL Feeder Monitor)
 * ==============================================================================
 * 
 * Hardware Architecture:
 * - Edge Microcontroller       : ESP32 (Dual-Core Tensilica LX6, 240 MHz)
 * - Precision Analog Interface : Texas Instruments ADS1115 (16-bit Delta-Sigma ADC, I2C: 0x48)
 * - Current Sensors            : 4x Allegro MicroSystems ACS712-05B (185 mV/A Sensitivity)
 *     * ADS1115 Channel A0     : I_in (Entering line current)
 *     * ADS1115 Channel A1     : I_out (Downstream line current to Zone 2)
 *     * ADS1115 Channel A2     : I_auth1 (House 1 consumer load)
 *     * ADS1115 Channel A3     : I_auth2 (House 2 consumer load)
 * - Local Diagnostics          : 16x2 HD44780 LCD via PCF8574 I2C Expander (I2C: 0x27)
 * - Isolation Protection       : 10A Optoisolated Electromechanical Safety Relay (GPIO 26)
 * - Status LED Indicator       : GPIO 2 (Built-in LED, flashes on theft)
 * 
 * Libraries Required:
 * - Adafruit_ADS1X15
 * - LiquidCrystal_I2C
 * - ArduinoJson (v6 or v7)
 * - WiFi & HTTPClient (Built-in ESP32 core)
 * - Wire (I2C communication)
 * ==============================================================================
 */

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_ADS1X15.h>
#include <LiquidCrystal_I2C.h>

// ---------- Network & Server Credentials ----------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Target Node.js Backend Server API
const char* SERVER_URL    = "http://172.30.194.27:5000/api/telemetry";

// Telemetry Transmit Interval
const unsigned long TRANSMIT_INTERVAL_MS = 3000;

// ---------- Hardware Pin Definitions ----------
#define PIN_RELAY     26    // Optoisolated Relay Control
#define PIN_LED       2     // Status LED Indicator
#define SDA_PIN       21    // ESP32 I2C SDA
#define SCL_PIN       22    // ESP32 I2C SCL

// ---------- Sensor & Calibration Parameters ----------
// ACS712-05B sensitivity: 185 mV/A = 0.185 V/A
const float ACS712_SENSITIVITY = 0.185; 
const float THEFT_THRESHOLD   = 0.15;   // In Amperes (150 mA)
const int SAMPLES_COUNT       = 400;    // Number of ADC samples for RMS calculation

// ---------- Hardware Peripherals ----------
Adafruit_ADS1115 ads; // Default I2C address 0x48
LiquidCrystal_I2C lcd(0x27, 16, 2); // 16x2 LCD at 0x27

// ---------- State Variables ----------
unsigned long lastTransmitTime = 0;
String currentRelayStatus = "CLOSED"; // CLOSED = Power supplied; OPEN = Tripped

/**
 * Measure true RMS current from ADS1115 channel with zero-current Vref offset tracking
 */
float measureACS712Rms(uint8_t channel) {
  long sumSquare = 0;
  long sumLinear = 0;

  // Phase 1: Determine zero-current DC quiescent voltage (nominally Vcc/2 ~ 2.5V)
  for (int i = 0; i < 50; i++) {
    int16_t sample = ads.readADC_SingleEnded(channel);
    sumLinear += sample;
    delayMicroseconds(100);
  }
  float offsetRaw = (float)sumLinear / 50.0;

  // Phase 2: Sample AC waveform and compute RMS
  for (int i = 0; i < SAMPLES_COUNT; i++) {
    int16_t sample = ads.readADC_SingleEnded(channel);
    float centered = (float)sample - offsetRaw;
    sumSquare += centered * centered;
    delayMicroseconds(200);
  }

  float meanSquare = (float)sumSquare / (float)SAMPLES_COUNT;
  // ADS1115 at GAIN_ONE: +/-4.096V range, 1 bit = 0.125 mV (0.000125V)
  float rmsVolts = (sqrt(meanSquare) * 0.000125);
  float rmsCurrent = rmsVolts / ACS712_SENSITIVITY;

  // Clamp low-level sensor noise floor
  if (rmsCurrent < 0.03) {
    rmsCurrent = 0.0;
  }
  return rmsCurrent;
}

/**
 * Connect to WiFi Access Point
 */
void connectToWiFi() {
  Serial.print("[WiFi] Connecting to SSID: ");
  Serial.println(WIFI_SSID);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("WiFi Connecting");
  lcd.setCursor(0, 1);
  lcd.print(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 25) {
    delay(500);
    Serial.print(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected!");
    Serial.print("[WiFi] IP: ");
    Serial.println(WiFi.localIP());

    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi Connected!");
    lcd.setCursor(0, 1);
    lcd.print(WiFi.localIP());
    delay(1500);
  } else {
    Serial.println("\n[WiFi] Connection failed. Will retry...");
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi Timeout");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  // Initialize GPIO
  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_RELAY, LOW); // LOW = Relay Contact CLOSED (Power ON)
  digitalWrite(PIN_LED, LOW);

  // Initialize I2C Bus
  Wire.begin(SDA_PIN, SCL_PIN);

  // Initialize 16x2 I2C LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("VoltGard System");
  lcd.setCursor(0, 1);
  lcd.print("KCL Feeder Mon");
  delay(1500);

  // Initialize ADS1115 ADC
  // GAIN_ONE: +/-4.096V (fits 0-3.3V / 0-5V attenuated ACS712 signals)
  ads.setGain(GAIN_ONE);
  if (!ads.begin(0x48)) {
    Serial.println("[ERROR] Failed to initialize ADS1115! Check I2C wiring.");
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("ADS1115 Error!");
  } else {
    Serial.println("[ADS1115] 16-Bit ADC initialized at 0x48.");
  }

  // Connect to Network
  connectToWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
    delay(2000);
    return;
  }

  unsigned long currentMillis = millis();
  if (currentMillis - lastTransmitTime >= TRANSMIT_INTERVAL_MS) {
    lastTransmitTime = currentMillis;

    // 1. Read 4x ACS712-05B Current Sensors via ADS1115
    float I_in    = measureACS712Rms(0); // Channel A0
    float I_out   = measureACS712Rms(1); // Channel A1
    float I_auth1 = measureACS712Rms(2); // Channel A2
    float I_auth2 = measureACS712Rms(3); // Channel A3

    // 2. Evaluate Kirchhoff's Current Law (KCL):
    // I_theft = I_in - I_out - (I_auth1 + I_auth2)
    float authorizedSum = I_auth1 + I_auth2;
    float I_theft = I_in - I_out - authorizedSum;
    if (I_theft < 0.0) I_theft = 0.0;

    bool theftDetected = (I_theft > THEFT_THRESHOLD);

    // 3. Update Diagnostics Display (16x2 LCD)
    lcd.clear();
    if (theftDetected) {
      digitalWrite(PIN_LED, HIGH);
      lcd.setCursor(0, 0);
      lcd.print("!THEFT DETECTED!");
      lcd.setCursor(0, 1);
      lcd.printf("I_th:%.2fA RL:%s", I_theft, currentRelayStatus.c_str());
    } else {
      digitalWrite(PIN_LED, LOW);
      lcd.setCursor(0, 0);
      lcd.printf("In:%.2fA Out:%.2f", I_in, I_out);
      lcd.setCursor(0, 1);
      lcd.printf("H1:%.2f H2:%.2f", I_auth1, I_auth2);
    }

    // 4. Construct Telemetry JSON Payload
    StaticJsonDocument<512> doc;
    doc["zone"]          = "Zone 1 - Main Feeder";
    doc["I_in"]          = round(I_in * 1000.0) / 1000.0;
    doc["I_out"]         = round(I_out * 1000.0) / 1000.0;
    doc["I_auth1"]       = round(I_auth1 * 1000.0) / 1000.0;
    doc["I_auth2"]       = round(I_auth2 * 1000.0) / 1000.0;
    doc["I_theft"]       = round(I_theft * 1000.0) / 1000.0;
    doc["theftDetected"] = theftDetected;
    doc["relayStatus"]   = currentRelayStatus;

    String jsonString;
    serializeJson(doc, jsonString);

    // 5. Ingest Telemetry to Node.js Backend Server
    HTTPClient http;
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");

    Serial.printf("[HTTP] Ingesting: %s\n", jsonString.c_str());
    int httpResponseCode = http.POST(jsonString);

    if (httpResponseCode > 0) {
      String responseBody = http.getString();
      Serial.printf("[HTTP %d] Response: %s\n", httpResponseCode, responseBody.c_str());

      // Parse server response for remote relay actuation commands
      StaticJsonDocument<512> respDoc;
      DeserializationError error = deserializeJson(respDoc, responseBody);
      if (!error) {
        const char* targetRelay = respDoc["targetRelayAction"];
        if (targetRelay && String(targetRelay) == "OPEN") {
          currentRelayStatus = "OPEN";
          digitalWrite(PIN_RELAY, HIGH); // Trip Relay
          Serial.println("[RELAY] Isolation tripped by server command!");
        } else if (targetRelay && String(targetRelay) == "CLOSED") {
          currentRelayStatus = "CLOSED";
          digitalWrite(PIN_RELAY, LOW); // Restore Relay
        }
      }
    } else {
      Serial.printf("[HTTP ERROR] Failed to send POST: %s\n", http.errorToString(httpResponseCode).c_str());
    }
    http.end();
  }
}
