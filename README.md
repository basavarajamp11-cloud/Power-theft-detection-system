# Power Theft Detection System

An IoT-enabled electrical feeder monitor that applies Kirchhoff's Current Law (KCL) across low-voltage distribution segments to identify, quantify, and report unauthorized power tapping in real time.
## System Overview
- **Edge Microcontroller:** ESP32 (Dual-Core Tensilica LX6, 240 MHz)
- **Precision Analog Interface:** Texas Instruments ADS1115 (16-bit Delta-Sigma ADC)
- **Current Sensing:** 4x Allegro MicroSystems ACS712-05B Hall-Effect Transducers
- **Local Diagnostics:** 16x2 HD44780 LCD via PCF8574 I2C Expander
- **Isolation Protection:** 10A Optoisolated Electromechanical Safety Relay
- **Backend Infrastructure:** Node.js, Express REST API, Twilio WhatsApp API
