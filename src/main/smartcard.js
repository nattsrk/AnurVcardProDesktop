const { NFC } = require('nfc-pcsc');
const { ipcMain } = require('electron');

let currentReader = null;
let currentMode = 'READ'; // 'READ' or 'WRITE'
let writeData = null; // Data to write when card is detected
let writeInProgress = false; // Guard flag to prevent multiple simultaneous writes

function initCardReader(onCardDetected, onError) {
  const nfc = new NFC();
  console.log('[smartcard] Reader started for structured data');

  nfc.on('reader', reader => {
    console.log(`[smartcard] Reader: ${reader.reader.name}`);
    reader.autoProcessing = false;
    currentReader = reader;

    reader.on('card', async card => {
      console.log('[smartcard] Card detected');
      try {
        // Get UID
        const getUid = Buffer.from([0xFF, 0xCA, 0x00, 0x00, 0x00]);
        const uidResp = await reader.transmit(getUid, 40);
        const uid = uidResp.slice(0, -2).toString('hex').toUpperCase();

        if (currentMode === 'READ') {
          // READ MODE: Read card data
          console.log('[smartcard] READ mode - reading card');
          // Add delay for consistent reading
          await new Promise(resolve => setTimeout(resolve, 300));
          const structuredData = await readStructuredData(reader);

          onCardDetected({
            uid,
            mode: 'READ',
            ...structuredData,
            reader: reader.reader.name,
            timestamp: new Date().toISOString()
          });

        } else if (currentMode === 'WRITE' && writeData && !writeInProgress) {
          // WRITE MODE: Write data to card (with guard flag)
          writeInProgress = true;
          console.log('[smartcard] 🚀 Starting single write operation...');
          try {
            const writeResult = await performSmartSync(reader, {}, writeData);

            onCardDetected({
              uid,
              mode: 'WRITE',
              status: writeResult.success ? 'success' : 'error',
              message: writeResult.success ? `Smart Sync successful! ${writeResult.recordsWritten || 0} records written` : writeResult.error,
              recordsWritten: writeResult.recordsWritten || 0,
              reader: reader.reader.name,
              timestamp: new Date().toISOString()
            });

            // Clear write data after writing
            writeData = null;
          } catch (err) {
            console.error('[smartcard] ❌ Write failed:', err);
            onCardDetected({
              uid,
              mode: 'WRITE',
              status: 'error',
              message: `Write failed: ${err.message}`,
              recordsWritten: 0,
              reader: reader.reader.name,
              timestamp: new Date().toISOString()
            });
          } finally {
            writeInProgress = false;
          }

        } else if (currentMode === 'WRITE' && !writeData) {
          // Card detected but no write data prepared yet
          console.log('[smartcard] WRITE mode - but no data prepared');
          onCardDetected({
            uid,
            mode: 'WRITE',
            status: 'waiting',
            message: 'Click "Write to Card" button first',
            reader: reader.reader.name,
            timestamp: new Date().toISOString()
          });
        } else {
          // Default: read mode
          const structuredData = await readStructuredData(reader);
          onCardDetected({
            uid,
            mode: currentMode,
            ...structuredData,
            reader: reader.reader.name,
            timestamp: new Date().toISOString()
          });
        }

      } catch (err) {
        console.error('[smartcard] Error:', err);
        onCardDetected({
          status: 'error',
          message: err.message,
          mode: currentMode
        });
      }
    });

    reader.on('card.off', () => {
      console.log('[smartcard] Card removed');
      onCardDetected({ status: 'removed', mode: currentMode });
    });

    reader.on('error', err => {
      console.error('[smartcard] Reader error:', err);
      if (onError) onError(err);
    });
  });

  nfc.on('error', err => {
    console.error('[smartcard] NFC error:', err);
    if (onError) onError(err);
  });

  return nfc;
}

// IPC listener for setting write data
ipcMain.on('set-write-data', (event, data) => {
  writeData = data;
  console.log('[smartcard] Write dataset received');
});
async function readStructuredData(reader) {
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[smartcard] Read attempt ${attempt}/${maxRetries}`);

      // Add longer initial delay for card stability
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Select NDEF Application
      const SELECT_NDEF = Buffer.from([
        0x00, 0xA4, 0x04, 0x00, 0x07,
        0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00
      ]);
      await reader.transmit(SELECT_NDEF, 40);

      // Select CC File
      const SELECT_CC = Buffer.from([0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x03]);
      await reader.transmit(SELECT_CC, 40);

      // Read CC
      const READ_CC = Buffer.from([0x00, 0xB0, 0x00, 0x00, 0x0F]);
      await reader.transmit(READ_CC, 150);

      // Select NDEF File
      const SELECT_NDEF_FILE = Buffer.from([0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04]);
      await reader.transmit(SELECT_NDEF_FILE, 40);

      // Read NDEF Length
      const READ_LEN = Buffer.from([0x00, 0xB0, 0x00, 0x00, 0x02]);
      const lenResp = await reader.transmit(READ_LEN, 150);
      const ndefLength = (lenResp[0] << 8) | lenResp[1];

      console.log(`[smartcard] NDEF length: ${ndefLength} bytes`);

      if (ndefLength === 0 || ndefLength > 8192) {
        throw new Error('No NDEF data on card or invalid length');
      }

      // Read NDEF Data in larger chunks (250 bytes max)
      const chunks = [];
      let offset = 2;
      while (offset < ndefLength + 2) {
        const toRead = Math.min(250, ndefLength + 2 - offset);
        const READ_DATA = Buffer.from([
          0x00, 0xB0,
          (offset >> 8) & 0xFF,
          offset & 0xFF,
          toRead
        ]);
        const data = await reader.transmit(READ_DATA, toRead + 100);
        chunks.push(data.slice(0, -2));
        offset += toRead;
      }

      const ndefData = Buffer.concat(chunks);
      console.log(`[smartcard] Raw NDEF buffer length: ${ndefData.length}`);
      console.log(`[smartcard] Raw NDEF data (hex): ${ndefData.toString('hex')}`);

      const parsedData = parseStructuredNdefData(ndefData);
      console.log(`[smartcard] Parsed data:`, parsedData);

      return parsedData;

    } catch (err) {
      console.error(`[smartcard] Read attempt ${attempt} failed:`, err.message);
      lastError = err;

      if (attempt < maxRetries) {
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  // All retries failed
  throw new Error(`Failed to read card after ${maxRetries} attempts: ${lastError.message}`);
}

// Perform the actual write operation
async function performWrite(reader, data) {
  try {
    console.log('[smartcard] Starting write operation...');

    // ============================================
    // STEP 1: Read existing card data for validation
    // ============================================
    let existingCardData = null;
    try {
      // Add a small delay to ensure card is ready
      await new Promise(resolve => setTimeout(resolve, 500));
      existingCardData = await readStructuredData(reader);
      console.log('[smartcard] Card has existing data - validating user');
    } catch (err) {
      console.log('[smartcard] Card read failed during validation:', err.message);
      // For sync operations, if we can't read the card, assume it's empty and allow write
      // This prevents sync from failing due to intermittent read issues
      existingCardData = null;
    }

    // ============================================
    // STEP 2: Validate user ownership (3-field check)
    // ============================================
    if (existingCardData && existingCardData.personalInfo) {
      // Extract card data (normalize for comparison)
      const cardName = (existingCardData.personalInfo['Full Name'] || '').trim().toLowerCase();
      const cardEmail = (existingCardData.personalInfo['Email'] || '').trim().toLowerCase();
      const cardPhone = (existingCardData.personalInfo['Phone'] || '').trim().replace(/\s+/g, '').replace(/[^0-9+]/g, '');

      // Extract session data (normalize for comparison)
      const sessionName = (data.personalInfo['Full Name'] || '').trim().toLowerCase();
      const sessionEmail = (data.personalInfo['Email'] || '').trim().toLowerCase();
      const sessionPhone = (data.personalInfo['Phone'] || '').trim().replace(/\s+/g, '');
      // Compare all three fields
      const nameMatches = cardName === sessionName;
      const emailMatches = cardEmail === sessionEmail;
      const phoneMatches = cardPhone === sessionPhone;

      console.log('[smartcard] Validation results:', {
        nameMatches,
        emailMatches,
        phoneMatches,
        cardName,
        sessionName,
        cardEmail,
        sessionEmail,
        cardPhone,
        sessionPhone
      });

      // If ANY field doesn't match, deny access
      if (!nameMatches || !emailMatches || !phoneMatches) {
        console.log('[smartcard] VALIDATION FAILED - User mismatch detected');
        return {
          status: 'error',
          message: 'Access Denied: This card belongs to a different user. Cannot write data.',
          recordsCount: 0
        };
      }

      console.log('[smartcard] VALIDATION PASSED - User ownership confirmed');

      // ============================================
      // STEP 3: Check for duplicate policies
      // ============================================
      // TEMPORARILY DISABLED FOR TESTING MERGED WRITES
      /*
      if (data.insurancePolicies && data.insurancePolicies.length > 0) {
        const existingPolicies = existingCardData.insuranceInfo || [];
        const existingPolicyNumbers = new Set(
          existingPolicies
            .map(p => p['Policy Number'])
            .filter(Boolean)
            .map(num => num.trim().toUpperCase())
        );

        console.log('[smartcard] Existing policy numbers on card:', Array.from(existingPolicyNumbers));
        console.log('[smartcard] Incoming policy numbers:', data.insurancePolicies.map(p => p.policyNumber));

        // Filter out policies that already exist
        const newPolicies = data.insurancePolicies.filter(policy => {
          const policyNum = (policy.policyNumber || '').trim().toUpperCase();
          return policyNum && !existingPolicyNumbers.has(policyNum);
        });

        console.log(`[smartcard] Found ${newPolicies.length} new policies out of ${data.insurancePolicies.length} total`);

        // If no new policies to write, return warning
        if (newPolicies.length === 0) {
          console.log('[smartcard] All policies already exist on card - no write needed');
          return {
            status: 'warning',
            message: 'All policies already exist on the card. No changes made.',
            recordsCount: 0
          };
        }

        // Update data to write only NEW policies
        data.insurancePolicies = newPolicies;
        console.log('[smartcard] Will write only new policies:', newPolicies.map(p => p.policyNumber));
      }
      */
    } else {
      console.log('[smartcard] First-time card write - no validation needed');
    }

    // ============================================
    // STEP 4: Proceed with normal write operation
    // ============================================
    const records = [];

    // 1. URI Record for VCard URL
    if (data.vCardUrl) {
      const uriRecord = createUriRecord(data.vCardUrl);
      records.push(uriRecord);
    }

    // 2. MIME Record for VCard personal info
    if (data.personalInfo) {
      const vCardData = createVCardData(data.personalInfo);
      const mimeRecord = createMimeRecord('text/vcard', vCardData);
      records.push(mimeRecord);
    }

    // 3. Text Record for Emergency Contact
    if (data.emergencyContact && data.emergencyContact.name) {
      const emergencyText = createEmergencyContactText(data.emergencyContact);
      const textRecord = createTextRecord(emergencyText);
      records.push(textRecord);
    }

    // 4. Text Records for Insurance Policies (only NEW policies now)
    if (data.insurancePolicies && data.insurancePolicies.length > 0) {
      data.insurancePolicies.forEach(policy => {
        const policyText = createInsurancePolicyText(policy);
        const policyRecord = createTextRecord(policyText);
        records.push(policyRecord);
      });
    }

    if (records.length === 0) {
      return {
        status: 'error',
        message: 'No valid data to write',
        recordsCount: 0
      };
    }

    console.log(`[smartcard] Created ${records.length} NDEF records`);

    // Build NDEF message and write to card
    const ndefMessage = buildNdefMessage(records);
    await writeNdefToCard(reader, ndefMessage);

    console.log('[smartcard] Successfully wrote to card');

    return {
      status: 'success',
      message: `Successfully wrote ${records.length} records to card`,
      recordsCount: records.length
    };

  } catch (error) {
    console.error('[smartcard] Write error:', error);
    return {
      status: 'error',
      message: `Write failed: ${error.message}`,
      recordsCount: 0
    };
  }
}

// Build NDEF message from records
function buildNdefMessage(records) {
  const ndefRecords = [];

  records.forEach((record, index) => {
    const isFirst = index === 0;
    const isLast = index === records.length - 1;

    let flags = record.tnf;
    if (isFirst) flags |= 0x80; // MB (Message Begin)
    if (isLast) flags |= 0x40;  // ME (Message End)
    if (record.payload.length < 256) flags |= 0x10; // SR (Short Record)

    const typeLength = Buffer.from([record.type.length]);
    const payloadLength = record.payload.length < 256
      ? Buffer.from([record.payload.length])
      : Buffer.from([
        (record.payload.length >> 24) & 0xFF,
        (record.payload.length >> 16) & 0xFF,
        (record.payload.length >> 8) & 0xFF,
        record.payload.length & 0xFF
      ]);

    const typeBuffer = Buffer.from(record.type, 'utf-8');

    const ndefRecord = Buffer.concat([
      Buffer.from([flags]),
      typeLength,
      payloadLength,
      typeBuffer,
      record.payload
    ]);

    ndefRecords.push(ndefRecord);
  });

  const totalLength = Buffer.concat(ndefRecords).length;
  const lengthBytes = Buffer.from([
    (totalLength >> 8) & 0xFF,
    totalLength & 0xFF
  ]);

  return Buffer.concat([lengthBytes, ...ndefRecords]);
}

/**
 * Write NDEF message safely to the card — no recursion, block-safe
 */
async function writeNdefToCard(reader, ndefRecords) {
  console.log("[smartcard] 🪶 Starting NDEF write operation...");

  const ndefMessage = buildNdefMessage(ndefRecords);
  console.log(`[smartcard] 🧱 NDEF message length: ${ndefMessage.length} bytes`);

  // Select NDEF application
  await reader.transmit(Buffer.from([
    0x00, 0xA4, 0x04, 0x00, 0x07,
    0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00
  ]), 40);
  console.log("[smartcard] NDEF application selected");

  // Select NDEF file (E104)
  await reader.transmit(Buffer.from([
    0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04
  ]), 40);
  console.log("[smartcard] NDEF file selected");

  // Build TLV header (0x03 <len> <ndef> 0xFE)
  const tlvBuffer = Buffer.concat([
    Buffer.from([0x03, ndefMessage.length]),
    ndefMessage,
    Buffer.from([0xFE])
  ]);

  // Pad to full 4-byte boundary (as required by ACR122)
  const totalLength = Math.ceil(tlvBuffer.length / 4) * 4;
  const padded = Buffer.concat([tlvBuffer, Buffer.alloc(totalLength - tlvBuffer.length, 0x00)]);

  console.log(`[smartcard] ✍️ Writing ${padded.length} bytes to card (aligned to 4-byte blocks)...`);

  // Write data in 4-byte chunks
  const blockSize = 4;
  for (let i = 0; i < padded.length; i += blockSize) {
    const chunk = padded.slice(i, i + blockSize);
    const offset = i;
    const cmd = Buffer.concat([
      Buffer.from([0x00, 0xD6, offset >> 8, offset & 0xFF, blockSize]),
      chunk
    ]);
    await reader.transmit(cmd, 40);
  }

  console.log(`[smartcard] ✅ Successfully wrote ${ndefRecords.length} records (${padded.length} bytes total).`);

  return {
    success: true,
    recordsWritten: ndefRecords.length,
    bytesWritten: padded.length
  };
}

function parseStructuredNdefData(buffer) {
  console.log(`[smartcard] Parsing NDEF buffer of ${buffer.length} bytes`);

  const result = {
    personalInfo: {},
    emergencyContact: {},
    insurancePolicies: [],
    vCardUrl: null
  };

  let offset = 0;
  let recordCount = 0;

  while (offset < buffer.length) {
    const header = buffer[offset];
    if (header === 0x00) {
      console.log(`[smartcard] End of records at offset ${offset}`);
      break;
    }

    recordCount++;
    console.log(`[smartcard] Parsing record ${recordCount} at offset ${offset}, header: 0x${header.toString(16)}`);

    const tnf = header & 0x07;
    const sr = (header & 0x10) !== 0;
    const me = (header & 0x40) !== 0;

    offset++;

    if (offset >= buffer.length) {
      console.warn(`[smartcard] Buffer ended prematurely after header`);
      break;
    }

    const typeLength = buffer[offset++];
    const payloadLength = sr ? buffer[offset++] : buffer.readUInt32BE(offset);
    if (!sr) offset += 4;

    console.log(`[smartcard] Record ${recordCount}: TNF=${tnf}, SR=${sr}, ME=${me}, TypeLen=${typeLength}, PayloadLen=${payloadLength}`);

    if (offset + typeLength + payloadLength > buffer.length) {
      console.warn(`[smartcard] Record ${recordCount} extends beyond buffer (offset=${offset}, needed=${typeLength + payloadLength}, available=${buffer.length - offset})`);
      // Try to parse what we can
      const availableTypeLen = Math.min(typeLength, buffer.length - offset);
      const availablePayloadLen = Math.min(payloadLength, buffer.length - offset - availableTypeLen);

      const type = buffer.slice(offset, offset + availableTypeLen);
      offset += availableTypeLen;
      const payload = buffer.slice(offset, offset + availablePayloadLen);
      offset += availablePayloadLen;

      console.log(`[smartcard] Parsing truncated record ${recordCount} with available data`);
      parseRecordContent(tnf, type, payload, result, recordCount);
    } else {
      const type = buffer.slice(offset, offset + typeLength);
      offset += typeLength;
      const payload = buffer.slice(offset, offset + payloadLength);
      offset += payloadLength;

      parseRecordContent(tnf, type, payload, result, recordCount);
    }

    if (me) {
      console.log(`[smartcard] Message End flag set, stopping parsing`);
      break;
    }
  }

  console.log(`[smartcard] Parsed ${recordCount} records total`);
  console.log(`[smartcard] Final result:`, result);

  return result;
}

function parseRecordContent(tnf, type, payload, result, recordNum) {
  console.log(`[smartcard] Record ${recordNum} content: TNF=${tnf}, Type="${type.toString()}", PayloadLen=${payload.length}`);

  // Parse based on content
  if (tnf === 0x01 && type.toString() === 'U') {
    // URI Record - VCard URL
    const prefixes = ['', 'http://www.', 'https://www.', 'http://', 'https://'];
    const prefix = prefixes[payload[0]] || '';
    result.vCardUrl = prefix + payload.slice(1).toString('utf-8');
    console.log(`[smartcard] Parsed URI: ${result.vCardUrl}`);

  } else if (tnf === 0x02 && type.toString().includes('vcard')) {
    // VCard MIME - Personal Info
    const vCardData = payload.toString('utf-8');
    console.log(`[smartcard] VCard data:\n${vCardData}`);
    const lines = vCardData.split(/[\r\n]+/);

    lines.forEach(line => {
      if (line.startsWith('FN:')) result.personalInfo['Full Name'] = line.substring(3);
      if (line.startsWith('TEL:')) result.personalInfo['Phone'] = line.substring(4);
      if (line.startsWith('EMAIL:')) result.personalInfo['Email'] = line.substring(6);
      if (line.startsWith('ORG:')) result.personalInfo['Organization'] = line.substring(4);
      if (line.startsWith('TITLE:')) result.personalInfo['Job Title'] = line.substring(6);
      if (line.startsWith('ADR:')) result.personalInfo['Address'] = line.substring(4);
    });
    console.log(`[smartcard] Parsed personal info:`, result.personalInfo);

  } else if (tnf === 0x01 && type.toString() === 'T') {
    // Text Record
    const langLen = payload[0] & 0x3F;
    const text = payload.slice(1 + langLen).toString('utf-8');
    console.log(`[smartcard] Text record content:\n${text}`);

    if (text.includes('EMERGENCY CONTACT')) {
      // Parse Emergency Contact
      const lines = text.split(/[\r\n]+/);
      lines.forEach(line => {
        if (line.includes('Name:')) result.emergencyContact['Name'] = line.split(':')[1]?.trim();
        if (line.includes('Mobile:')) result.emergencyContact['Mobile'] = line.split(':')[1]?.trim();
        if (line.includes('Blood Group:')) result.emergencyContact['Blood Group'] = line.split(':')[1]?.trim();
        if (line.includes('Location:')) result.emergencyContact['Location'] = line.split(':')[1]?.trim();
        if (line.includes('Relationship:')) result.emergencyContact['Relationship'] = line.split(':')[1]?.trim();
      });
      console.log(`[smartcard] Parsed emergency contact:`, result.emergencyContact);

    } else if (text.includes('INSURANCE INFORMATION')) {
      // Parse Insurance Policy - extract all fields
      const policy = {};
      const lines = text.split(/[\r\n]+/);
      console.log(`[smartcard] Insurance policy lines:`, lines);

      lines.forEach(line => {
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();

          // Map to consistent field names
          if (key === 'Policyholder') policy['Policyholder'] = value;
          else if (key === 'Age') policy['Age'] = value;
          else if (key === 'Insurer') policy['Insurer'] = value;
          else if (key === 'Policy Type') policy['Policy Type'] = value;
          else if (key === 'Premium') policy['Premium'] = value;
          else if (key === 'Sum Assured') policy['Sum Assured'] = value;
          else if (key === 'Policy Start') policy['Policy Start'] = value;
          else if (key === 'Policy End') policy['Policy End'] = value;
          else if (key === 'Status') policy['Status'] = value;
          else if (key === 'Contact') policy['Contact'] = value;
          else if (key === 'Mobile') policy['Mobile'] = value;
          else if (key === 'Policy Number') policy['Policy Number'] = value;
        }
      });

      if (Object.keys(policy).length > 0) {
        result.insurancePolicies.push(policy);
        console.log(`[smartcard] Added policy:`, policy);
      } else {
        console.warn(`[smartcard] Policy parsed but no valid fields found`);
      }
    }
  } else {
    console.log(`[smartcard] Unrecognized record type: TNF=${tnf}, Type="${type.toString()}"`);
  }
}

async function getCardInfo() {
  // This function would need to be implemented to get card info without event
  // For now, return a placeholder
  return { status: 'no-card', message: 'No card detected' };
}

async function writeStructuredDataToCard(data) {
  // This function writes all structured data to card, overwriting existing data
  // Based on Android implementation: writeStructuredDataToCard()

  // For now, we'll implement a basic version that creates NDEF records
  // Full implementation would require card writing capabilities

  console.log('[smartcard] Writing structured data to card:', data);

  // Create NDEF records as per Android format:
  // 1. URI Record for VCard URL
  // 2. MIME Record for VCard personal info
  // 3. Text Record for Emergency Contact
  // 4. Text Records for Insurance Policies

  const records = [];

  // 1. URI Record for VCard URL
  if (data.vCardUrl) {
    const uriRecord = createUriRecord(data.vCardUrl);
    records.push(uriRecord);
  }

  // 2. MIME Record for VCard personal info
  if (data.personalInfo) {
    const vCardData = createVCardData(data.personalInfo);
    const mimeRecord = createMimeRecord('text/vcard', vCardData);
    records.push(mimeRecord);
  }

  // 3. Text Record for Emergency Contact
  if (data.emergencyContact && (data.emergencyContact.name || data.emergencyContact.Name)) {
    const emergencyText = createEmergencyContactText(data.emergencyContact);
    const textRecord = createTextRecord(emergencyText);
    records.push(textRecord);
  }

  // 4. Text Records for Insurance Policies
  if (data.insurancePolicies && data.insurancePolicies.length > 0) {
    data.insurancePolicies.forEach(policy => {
      const policyText = createInsurancePolicyText(policy);
      const policyRecord = createTextRecord(policyText);
      records.push(policyRecord);
    });
  }

  // In a real implementation, we would:
  // 1. Wait for card detection
  // 2. Format the card if needed
  // 3. Write the NDEF message with all records

  console.log(`[smartcard] Created ${records.length} NDEF records`);

  return {
    status: 'success',
    message: `Data written to card with ${records.length} records`,
    recordsCount: records.length
  };
}

// Helper functions for creating NDEF records
function createUriRecord(uri) {
  // TNF_WELL_KNOWN, Type: URI
  const prefixes = ['', 'http://www.', 'https://www.', 'http://', 'https://'];
  let prefixIndex = 0;
  let shortenedUri = uri;

  for (let i = 1; i < prefixes.length; i++) {
    if (uri.startsWith(prefixes[i])) {
      prefixIndex = i;
      shortenedUri = uri.substring(prefixes[i].length);
      break;
    }
  }

  return {
    tnf: 0x01, // TNF_WELL_KNOWN
    type: 'U',
    payload: Buffer.concat([Buffer.from([prefixIndex]), Buffer.from(shortenedUri, 'utf-8')])
  };
}

function createMimeRecord(mimeType, data) {
  // TNF_MIME_MEDIA
  return {
    tnf: 0x02, // TNF_MIME_MEDIA
    type: mimeType,
    payload: Buffer.from(data, 'utf-8')
  };
}

function createTextRecord(text) {
  // TNF_WELL_KNOWN, Type: Text
  const language = 'en';
  const statusByte = (language.length & 0x3F);
  const languageBytes = Buffer.from(language, 'utf-8');
  const textBytes = Buffer.from(text, 'utf-8');

  return {
    tnf: 0x01, // TNF_WELL_KNOWN
    type: 'T',
    payload: Buffer.concat([Buffer.from([statusByte]), languageBytes, textBytes])
  };
}

function createVCardData(personalInfo) {
  let vCard = 'BEGIN:VCARD\nVERSION:3.0\n';
  if (personalInfo['Full Name']) vCard += `FN:${personalInfo['Full Name']}\n`;
  if (personalInfo['Phone']) vCard += `TEL:${personalInfo['Phone']}\n`;
  if (personalInfo['Email']) vCard += `EMAIL:${personalInfo['Email']}\n`;
  if (personalInfo['Organization']) vCard += `ORG:${personalInfo['Organization']}\n`;
  if (personalInfo['Job Title']) vCard += `TITLE:${personalInfo['Job Title']}\n`;
  if (personalInfo['Address']) vCard += `ADR:${personalInfo['Address']}\n`;
  vCard += 'END:VCARD\n';
  return vCard;
}

function createEmergencyContactText(emergencyContact) {
  return `EMERGENCY CONTACT INFORMATION

Name: ${emergencyContact.name || ''}
Mobile: ${emergencyContact.mobile || ''}
Blood Group: ${emergencyContact.bloodGroup || ''}
Location: ${emergencyContact.location || ''}
Relationship: ${emergencyContact.relationship || ''}`;
}

function createInsurancePolicyText(policy) {
  return `INSURANCE INFORMATION - POLICY

Policyholder: ${policy.policyholder || ''}
Age: ${policy.age || ''}
Insurer: ${policy.insurer || ''}
Policy Type: ${policy.policyType || ''}
Premium: ${policy.premium || ''}
Sum Assured: ${policy.sumAssured || ''}
Policy Start: ${policy.policyStart || ''}
Policy End: ${policy.policyEnd || ''}
Status: ${policy.status || ''}
Contact: ${policy.contact || ''}
Mobile: ${policy.mobile || ''}
Policy Number: ${policy.policyNumber || ''}`;
}

async function syncBackendPoliciesToCard(backendPolicies) {
  // This function syncs missing backend policies to card without losing existing data
  // Based on Android implementation: syncBackendPoliciesToCard()

  console.log('[smartcard] Syncing backend policies to card:', backendPolicies);

  // In the Android implementation:
  // 1. Read existing card data
  // 2. Identify missing policies (in backend but not on card)
  // 3. Merge existing data with missing policies
  // 4. Write merged data back to card

  // For now, we'll simulate this process
  // Real implementation would:
  // - Read current card data using readStructuredData()
  // - Compare with backendPolicies
  // - Create merged data
  // - Write back to card

  const existingData = {
    personalInfo: {},
    emergencyContact: {},
    insurancePolicies: [],
    vCardUrl: null
  }; // In real implementation: await readStructuredData(reader);

  // Find policies in backend but not in existing card data
  const existingPolicyNumbers = new Set(existingData.insurancePolicies.map(p => p.policyNumber));
  const missingPolicies = backendPolicies.filter(policy =>
    !existingPolicyNumbers.has(policy.policyNumber)
  );

  if (missingPolicies.length === 0) {
    return {
      status: 'success',
      message: 'No new policies to sync',
      syncedCount: 0
    };
  }

  // Merge data: existing + missing policies
  const mergedData = {
    ...existingData,
    insurancePolicies: [...existingData.insurancePolicies, ...missingPolicies]
  };

  // Write merged data to card
  const writeResult = await writeStructuredDataToCard(mergedData);

  return {
    status: 'success',
    message: `Synced ${missingPolicies.length} policies to card`,
    syncedCount: missingPolicies.length,
    totalRecords: writeResult.recordsCount
  };
}

async function syncCardToBackend(cardPolicies) {
  // This function uploads card-only policies to backend API
  // Based on Android implementation: syncCardToBackend()

  console.log('[smartcard] Syncing card policies to backend:', cardPolicies);

  // In Android implementation:
  // 1. Identify card-only policies (not in backend)
  // 2. For each policy: convert to API format and POST to backend
  // 3. Track success/failure count

  // For now, we'll simulate the API calls
  // Real implementation would make HTTP requests to backend

  let successCount = 0;
  let failureCount = 0;
  const results = [];

  for (const policy of cardPolicies) {
    try {
      // Convert card policy format to API format
      const apiPolicy = {
        userId: 123, // Would come from user session
        policyNumber: policy.policyNumber,
        policyType: policy.policyType,
        insurerName: policy.insurer,
        premiumAmount: parseFloat(policy.premium) || 0,
        sumAssured: parseFloat(policy.sumAssured) || 0,
        policyStartDate: policy.policyStart,
        policyEndDate: policy.policyEnd,
        status: policy.status
      };

      // Simulate API call
      console.log('[smartcard] POST /api/insurance:', apiPolicy);

      // In real implementation:
      // const response = await fetch('/api/insurance', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(apiPolicy)
      // });
      // if (!response.ok) throw new Error('API call failed');

      results.push({ policyNumber: policy.policyNumber, status: 'success' });
      successCount++;

    } catch (error) {
      console.error(`[smartcard] Failed to sync policy ${policy.policyNumber}:`, error);
      results.push({ policyNumber: policy.policyNumber, status: 'failed', error: error.message });
      failureCount++;
    }
  }

  return {
    status: 'success',
    message: `Synced ${successCount} policies to backend, ${failureCount} failed`,
    successCount,
    failureCount,
    results
  };
}

async function compareCardAndBackendData(backendPolicies) {
  // This function compares card policies vs backend policies
  // Based on Android implementation: compareCardAndBackendData()

  console.log('[smartcard] Comparing card and backend data');

  // In Android implementation:
  // 1. Find policies in BACKEND but not in CARD → "Sync to Card" needed
  // 2. Find policies in CARD but not in BACKEND → "Sync to Backend" needed
  // 3. Check data differences in matching policies

  // For now, simulate reading card data
  const cardData = {
    personalInfo: {},
    emergencyContact: {},
    insurancePolicies: [
      { policyNumber: 'POL001', insurer: 'Existing Insurer', status: 'Active' }
    ],
    vCardUrl: null
  }; // In real implementation: await readStructuredData(reader);

  const cardPolicies = cardData.insurancePolicies;
  const differences = [];

  // Find policies in backend but not in card
  const cardPolicyNumbers = new Set(cardPolicies.map(p => p.policyNumber));
  const backendOnlyPolicies = backendPolicies.filter(policy =>
    !cardPolicyNumbers.has(policy.policyNumber)
  );

  // Find policies in card but not in backend
  const backendPolicyNumbers = new Set(backendPolicies.map(p => p.policyNumber));
  const cardOnlyPolicies = cardPolicies.filter(policy =>
    !backendPolicyNumbers.has(policy.policyNumber)
  );

  // Check for data differences in matching policies
  const matchingPolicies = cardPolicies.filter(policy =>
    backendPolicyNumbers.has(policy.policyNumber)
  );

  matchingPolicies.forEach(cardPolicy => {
    const backendPolicy = backendPolicies.find(p => p.policyNumber === cardPolicy.policyNumber);
    if (backendPolicy) {
      const fieldsToCheck = ['status', 'insurer', 'premium'];
      fieldsToCheck.forEach(field => {
        if (cardPolicy[field] !== backendPolicy[field]) {
          differences.push({
            policyNumber: cardPolicy.policyNumber,
            field,
            cardValue: cardPolicy[field],
            backendValue: backendPolicy[field]
          });
        }
      });
    }
  });

  const needsSync = backendOnlyPolicies.length > 0 || cardOnlyPolicies.length > 0 || differences.length > 0;

  return {
    cardPolicies,
    backendPolicies,
    backendOnlyPolicies,
    cardOnlyPolicies,
    differences,
    needsSync,
    summary: {
      backendOnlyCount: backendOnlyPolicies.length,
      cardOnlyCount: cardOnlyPolicies.length,
      differencesCount: differences.length
    }
  };
}

// Set current mode (READ or WRITE)
function setMode(mode) {
  if (mode !== 'READ' && mode !== 'WRITE') {
    throw new Error('Invalid mode. Must be "READ" or "WRITE"');
  }
  currentMode = mode;
  console.log(`[smartcard] Mode changed to: ${mode}`);
  return { mode: currentMode };
}

// Get current mode
function getMode() {
  return { mode: currentMode };
}

// Prepare data for writing (called when Write button is clicked)
function prepareWrite(data) {
  writeData = data;
  console.log('[smartcard] Write data prepared. Waiting for card tap...');
  return {
    status: 'ready',
    message: 'Data prepared. Please tap your card now.'
  };
}

// Prepare full data for sync writing (includes all existing data + new policies)
function prepareWriteFull(data) {
  writeData = data;
  console.log('[smartcard] Full write data prepared for sync. Waiting for card tap...');
  return {
    status: 'ready',
    message: 'Full data prepared for sync. Please tap your card now.'
  };
}

// Cancel pending write operation
function cancelWrite() {
  writeData = null;
  console.log('[smartcard] Write operation cancelled');
  return {
    status: 'cancelled',
    message: 'Write operation cancelled'
  };
}

/************************************************************
 * SMART SYNC CONSOLIDATED FUNCTIONS
 * (prepareMergedCardData, buildCompleteNdefRecords, performSmartSync)
 ************************************************************/

/**
 * Step 1. Prepare unified data by merging backend + existing card
 */
function prepareMergedCardData(writeData = {}) {
  console.log("[smartcard] 🧩 Incoming writeData:", writeData);

  // Use exactly what UI sends — don't blank out fields
  const merged = {
    personalInfo: writeData.personalInfo || {},
    emergencyContact: writeData.emergencyContact || {},
    insurancePolicies: Array.isArray(writeData.insurancePolicies)
      ? writeData.insurancePolicies
      : [],
    vCardUrl:
      writeData.vCardUrl ||
      (writeData.personalInfo?.Email
        ? `https://vcard.tecgs.com:3000/profile/${(writeData.personalInfo.Email || "")
          .split("@")[0]
          .toLowerCase()}`
        : "")
  };

  console.log("[smartcard] ✅ Merged data finalized:", merged);
  return merged;
}


/**
 * Step 2. Build all NDEF records from unified data
 */
function buildCompleteNdefRecords(mergedData) {
  console.log('[smartcard] 🧩 Building complete NDEF record set...');
  const records = [];

  // --- URI Record (VCard URL) ---
  if (mergedData.vCardUrl) {
    const uriRecord = createUriRecord(mergedData.vCardUrl);
    records.push(uriRecord);
  }

  // --- Personal Info (MIME) ---
  if (mergedData.personalInfo) {
    const mimeRecord = createMimeRecord('text/vcard', JSON.stringify(mergedData.personalInfo));
    records.push(mimeRecord);
  }

  // --- Emergency Contact (Text) ---
  if (mergedData.emergencyContact && (mergedData.emergencyContact.Name || mergedData.emergencyContact.name)) {
    const emergencyText = createEmergencyContactText(mergedData.emergencyContact);
    const emergencyRecord = createTextRecord(emergencyText);
    records.push(emergencyRecord);
  }

  // --- Insurance Policies (Text) ---
  if (Array.isArray(mergedData.insurancePolicies)) {
    mergedData.insurancePolicies.forEach((policy, i) => {
      const policyText = createInsurancePolicyText(policy, i + 1);
      const policyRecord = createTextRecord(policyText);
      records.push(policyRecord);
    });
  }

  console.log(`[smartcard] ✅ Created ${records.length} NDEF records.`);
  return records;
}

/**
 * Perform Smart Sync (merge + write backend + card data)
 */
async function performSmartSync(reader, existingCardData = {}, backendData = {}) {
  console.log("[smartcard] 🚀 Starting Smart Sync operation...");
  console.log("[smartcard] 🧩 Incoming backendData:", backendData);

  try {
    // 1️⃣ Merge backend and card data
    const mergedData = await prepareMergedCardData(existingCardData, backendData);
    console.log("[smartcard] 🧠 Merged dataset prepared:", mergedData);

    // 2️⃣ Build NDEF record set
    const ndefRecords = buildCompleteNdefRecords(mergedData);
    console.log(`[smartcard] 🧩 Built ${ndefRecords.length} NDEF records.`);

    // 3️⃣ Write using safe NDEF writer
    const result = await writeNdefToCard(reader, ndefRecords);
    console.log("[smartcard] ✅ Smart Sync write completed successfully:", result);

    // 4️⃣ Return success to frontend
    return {
      status: "success",
      message: `Wrote ${ndefRecords.length} records (${result.bytesWritten} bytes) successfully.`,
      recordsWritten: result.recordsWritten
    };

  } catch (err) {
    console.error("[smartcard] ❌ Smart Sync failed:", err);
    return { status: "error", message: err.message || "Unknown write error" };
  }
}



module.exports = {
  initCardReader,
  setMode,
  getMode,
  // prepareWrite,
  prepareWriteFull,
  cancelWrite,
  syncBackendPoliciesToCard,
  syncCardToBackend,
  compareCardAndBackendData,
  performSmartSync
};