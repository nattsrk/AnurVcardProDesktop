const React = require('react');
const { ipcRenderer } = require('electron');

// Data classes equivalent
const InsuranceInfo = {
  policyHolder: '',
  age: '',
  insurer: '',
  policyType: '',
  premium: '',
  sumAssured: '',
  policyStart: '',
  policyEnd: '',
  status: 'Active',
  contact: '',
  mobile: '',
  policyNumber: ''
};

const ExtractedCardData = {
  personalInfo: {},
  emergencyContact: {},
  insuranceInfo: [],
  otherData: {}
};

const SyncComparisonData = {
  cardPolicies: [],
  backendPolicies: [],
  differences: [],
  needsSync: false
};

function SCMasterScreen({ onBack }) {
  // ✅ FIX 1: Get logged-in user from localStorage - MUST BE FIRST
  const userSession = JSON.parse(localStorage.getItem('userSession') || '{}');
  const loggedInUser = {
    userId: userSession.userId || 1,
    fullName: userSession.name || 'Guest User',
    email: userSession.email || 'guest@example.com',
    phone: userSession.phone || '0000000000'
  };

  const userId = loggedInUser.userId;

  // Read mode states
  const [currentMode, setCurrentMode] = React.useState('READ');
  const [nfcStatus, setNfcStatus] = React.useState('Initializing NFC...');
  const [cardDetected, setCardDetected] = React.useState(false);
  const [lastTapTime, setLastTapTime] = React.useState('');
  const [cardDataStatus, setCardDataStatus] = React.useState('');
  const [extractedData, setExtractedData] = React.useState(null);

  // Write mode states - Card Personalization
  const [writeStatus, setWriteStatus] = React.useState('Ready to write');
  const [isWriting, setIsWriting] = React.useState(false);

  // Write mode states - Data Sync
  const [backendInsuranceData, setBackendInsuranceData] = React.useState(null);
  const [isLoadingBackend, setIsLoadingBackend] = React.useState(false);
  const [backendError, setBackendError] = React.useState(null);
  const [syncComparison, setSyncComparison] = React.useState(null);
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [syncStatus, setSyncStatus] = React.useState('');

  // Personal Info - initialized from session
  const [fullName, setFullName] = React.useState(loggedInUser.fullName);
  const [phone, setPhone] = React.useState(loggedInUser.phone);
  const [email, setEmail] = React.useState(loggedInUser.email);
  const [organization, setOrganization] = React.useState('');
  const [jobTitle, setJobTitle] = React.useState('');
  const [address, setAddress] = React.useState('');

  // Emergency Contact - Start with empty values
  const [emergencyName, setEmergencyName] = React.useState('');
  const [emergencyPhone, setEmergencyPhone] = React.useState('');
  const [bloodGroup, setBloodGroup] = React.useState('');
  const [emergencyLocation, setEmergencyLocation] = React.useState('');
  const [emergencyRelationship, setEmergencyRelationship] = React.useState('');

  // Insurance List (Multiple Records) - Start with empty list
  const [insuranceList, setInsuranceList] = React.useState([{ ...InsuranceInfo }]);

  // VCard slug for Write mode - Start empty
  const [vCardSlug, setVCardSlug] = React.useState('');

  // Helper functions for sync
  const parsePremiumFromString = (premium) => {
    return parseFloat(premium.replace('₹', '').replace(',', '').replace('(Annual)', '').trim()) || 0.0;
  };

  const parseSumAssuredFromString = (sumAssured) => {
    return parseFloat(sumAssured.replace('₹', '').replace(',', '').replace('(1 Crore)', '').trim()) || 0.0;
  };

  // Fetch backend insurance data
  const fetchBackendInsuranceData = async () => {
    if (userId === -1) {
      setBackendError('User not logged in');
      return;
    }

    setIsLoadingBackend(true);
    setBackendError(null);

    try {
      const response = await fetch(`https://vcard.tecgs.com:3000/api/insurance?userId=${userId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setBackendInsuranceData(data);
          if (extractedData) {
            const comparison = compareCardAndBackendData(extractedData.insuranceInfo, data.policies || []);
            setSyncComparison(comparison);
          }
        } else {
          setBackendError('Failed to load backend data');
        }
      } else {
        setBackendError(`Failed to load backend data: ${response.status}`);
      }
    } catch (error) {
      setBackendError(`Network error: ${error.message}`);
    } finally {
      setIsLoadingBackend(false);
    }
  };

  // Sync card data to backend
  const syncCardToBackend = async () => {
    if (!syncComparison) return;

    const cardOnlyPolicies = syncComparison.cardPolicies.filter(cardPolicy => {
      return !syncComparison.backendPolicies.some(backendPolicy =>
        backendPolicy.policyNumber === cardPolicy['Policy Number']
      );
    });

    if (cardOnlyPolicies.length === 0) {
      setSyncStatus('No new policies to sync from card');
      return;
    }

    setIsSyncing(true);
    setSyncStatus('Starting sync from card to backend...');

    try {
      const result = await ipcRenderer.invoke('sync-to-backend', cardOnlyPolicies);
      setSyncStatus(result.message || 'Sync completed');
      setIsSyncing(false);
    } catch (error) {
      setSyncStatus(`Sync failed: ${error.message}`);
      setIsSyncing(false);
    }
  };

  // Sync backend policies to card
  const syncBackendToCard = async () => {
    if (!syncComparison) return;

    const backendOnlyPolicies = syncComparison.backendPolicies.filter(backendPolicy => {
      return !syncComparison.cardPolicies.some(cardPolicy =>
        cardPolicy['Policy Number'] === backendPolicy.policyNumber
      );
    });

    if (backendOnlyPolicies.length === 0) {
      setSyncStatus('No missing policies to sync to card');
      return;
    }

    setSyncStatus(`Found ${backendOnlyPolicies.length} policies to sync to card. Tap card to write them.`);

    const policiesToWrite = backendOnlyPolicies.map(policy => ({
      policyholder: policy.policyHolderName || '',
      age: policy.age || '',
      insurer: policy.insurerName || '',
      policyType: policy.policyType || '',
      premium: `₹${policy.premiumAmount} (Annual)` || '',
      sumAssured: `₹${policy.sumAssured}` || '',
      policyStart: policy.policyStartDate || '',
      policyEnd: policy.policyEndDate || '',
      status: policy.status || 'Active',
      contact: policy.contactEmail || '',
      mobile: policy.contactPhone || '',
      policyNumber: policy.policyNumber || ''
    }));

    setIsSyncing(true);
    try {
      const result = await ipcRenderer.invoke('sync-to-card', policiesToWrite);
      setSyncStatus(result.message || 'Sync to card completed');
      setIsSyncing(false);
    } catch (error) {
      setSyncStatus(`Sync to card failed: ${error.message}`);
      setIsSyncing(false);
    }
  };

  // Compare card and backend data
  const compareCardAndBackendData = (cardPolicies, backendPolicies) => {
    const differences = [];

    backendPolicies.forEach(backendPolicy => {
      const policyNumber = backendPolicy.policyNumber;
      const found = cardPolicies.some(cardPolicy => cardPolicy['Policy Number'] === policyNumber);
      if (!found) {
        differences.push(`Policy ${backendPolicy.policyNumber} exists in backend but not in card`);
      }
    });

    cardPolicies.forEach(cardPolicy => {
      const policyNumber = cardPolicy['Policy Number'];
      const found = backendPolicies.some(backendPolicy => backendPolicy.policyNumber === policyNumber);
      if (!found && policyNumber) {
        differences.push(`Policy ${policyNumber} exists in card but not in backend`);
      }
    });

    cardPolicies.forEach(cardPolicy => {
      const cardPolicyNumber = cardPolicy['Policy Number'];
      const backendPolicy = backendPolicies.find(bp => bp.policyNumber === cardPolicyNumber);
      if (backendPolicy) {
        if (cardPolicy['Status'] !== backendPolicy.status) {
          differences.push(`Policy ${cardPolicyNumber}: Status differs (Card: ${cardPolicy['Status']}, Backend: ${backendPolicy.status})`);
        }
        if (cardPolicy['Insurer'] !== backendPolicy.insurerName) {
          differences.push(`Policy ${cardPolicyNumber}: Insurer differs`);
        }
      }
    });

    return {
      cardPolicies,
      backendPolicies,
      differences,
      needsSync: differences.length > 0
    };
  };

  // Handle card detection
  React.useEffect(() => {
    const handleCardDetected = (event, data) => {
      console.log('[SCMasterScreen] Card detected:', data);

      if (currentMode === 'READ') {
        setCardDataStatus(data.message || 'Card read successfully');
        setExtractedData(data);
        setCardDetected(true);
        setLastTapTime(new Date().toLocaleTimeString());

        if (backendInsuranceData) {
          const comparison = compareCardAndBackendData(data.insuranceInfo || [], backendInsuranceData.policies || []);
          setSyncComparison(comparison);
        }
      } else if (currentMode === 'WRITE') {
        if (isWriting) {
          if (data.status === 'success') {
            setWriteStatus(`✅ ${data.message}`);
            setIsWriting(false);
            setCurrentMode('READ');
          } else {
            const emoji = data.status === 'error' ? '❌' : '⚠️';
            setWriteStatus(`${emoji} ${data.message}`);
            setIsWriting(false);
          }
        } else if (isSyncing) {
          if (data.status === 'success') {
            setSyncStatus(`✅ ${data.message}`);
            setIsSyncing(false);
          } else {
            setSyncStatus(`❌ ${data.message}`);
            setIsSyncing(false);
          }
        }
      }
    };

    const handleCardError = (event, error) => {
      console.log('[SCMasterScreen] Card error:', error);
      setNfcStatus(`Error: ${error}`);
      setCardDetected(false);
      setIsWriting(false);
      setIsSyncing(false);
    };

    ipcRenderer.on('card-detected', handleCardDetected);
    ipcRenderer.on('card-error', handleCardError);

    return () => {
      ipcRenderer.removeAllListeners('card-detected');
      ipcRenderer.removeAllListeners('card-error');
    };
  }, [currentMode, isWriting, isSyncing, backendInsuranceData]);

  // Set mode when currentMode changes
  React.useEffect(() => {
    ipcRenderer.invoke('set-mode', currentMode);
  }, [currentMode]);

  // Handle write to card
  const handleWriteToCard = async () => {
    const hasPersonal = fullName.trim() || phone.trim() || email.trim();
    const hasEmergency = emergencyName.trim() && emergencyPhone.trim();
    const hasInsurance = insuranceList.some(policy => policy.policyHolder.trim());

    if (!hasPersonal && !hasEmergency && !hasInsurance) {
      alert('Please fill at least one complete section (Personal Info, Emergency Contact, or Insurance)');
      return;
    }

    setIsWriting(true);
    setWriteStatus('Tap your card to write structured data...');

    const data = {
      vCardUrl: `https://vcard.tecgs.com:3000/profile/${vCardSlug}`,
      personalInfo: {
        fullName: fullName,
        phone: phone,
        email: email,
        organization: organization,
        jobTitle: jobTitle,
        address: address
      },
      emergencyContact: {
        name: emergencyName,
        mobile: emergencyPhone,
        bloodGroup,
        location: emergencyLocation,
        relationship: emergencyRelationship
      },
      insurancePolicies: insuranceList.map(policy => ({
        policyholder: policy.policyHolder,
        age: policy.age,
        insurer: policy.insurer,
        policyType: policy.policyType,
        premium: policy.premium,
        sumAssured: policy.sumAssured,
        policyStart: policy.policyStart,
        policyEnd: policy.policyEnd,
        status: policy.status,
        contact: policy.contact,
        mobile: policy.mobile,
        policyNumber: policy.policyNumber
      }))
    };

    try {
      await ipcRenderer.invoke('prepare-write', data);
    } catch (error) {
      setWriteStatus(`Error: ${error.message}`);
      setIsWriting(false);
    }
  };

  // Add insurance policy
  const addInsurancePolicy = () => {
    setInsuranceList([...insuranceList, { ...InsuranceInfo }]);
  };

  // Remove insurance policy
  const removeInsurancePolicy = (index) => {
    const newList = [...insuranceList];
    newList.splice(index, 1);
    setInsuranceList(newList);
  };

  // Update insurance policy
  const updateInsurancePolicy = (index, field, value) => {
    const newList = [...insuranceList];
    newList[index] = { ...newList[index], [field]: value };
    setInsuranceList(newList);
  };

  const styles = {
    container: {
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#000',
      color: '#fff',
      fontFamily: 'Arial, sans-serif'
    },
    header: {
      display: 'flex',
      justifyContent: 'flex-start',
      padding: '16px'
    },
    backButton: {
      backgroundColor: '#333',
      color: '#fff',
      border: 'none',
      padding: '10px 20px',
      borderRadius: '6px',
      cursor: 'pointer'
    },
    mainCard: {
      margin: '16px',
      backgroundColor: '#fff',
      borderRadius: '12px',
      overflow: 'hidden'
    },
    cardHeader: {
      padding: '16px',
      backgroundColor: '#333',
      color: '#fff',
      fontWeight: 'bold',
      fontSize: '18px'
    },
    cardContent: {
      padding: '16px'
    },
    modeToggle: {
      display: 'flex',
      justifyContent: 'space-evenly',
      marginTop: '16px'
    },
    modeButton: {
      padding: '12px 24px',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '16px',
      fontWeight: 'bold'
    },
    statusText: {
      marginTop: '8px',
      fontSize: '14px',
      color: '#666'
    },
    dataCard: {
      margin: '12px 0',
      borderRadius: '12px',
      overflow: 'hidden'
    },
    dataHeader: {
      padding: '16px',
      fontWeight: 'bold',
      fontSize: '18px'
    },
    dataContent: {
      padding: '20px',
      backgroundColor: '#fff'
    },
    dataRow: {
      display: 'flex',
      padding: '8px 0',
      borderBottom: '1px solid #f0f0f0'
    },
    dataLabel: {
      flex: '0 0 35%',
      color: '#666',
      fontWeight: '500'
    },
    dataValue: {
      flex: '1',
      color: '#333'
    },
    formGroup: {
      marginBottom: '16px'
    },
    formRow: {
      display: 'flex',
      gap: '10px',
      marginBottom: '10px'
    },
    input: {
      flex: '1',
      padding: '10px',
      backgroundColor: '#fff',
      color: '#000',
      border: '1px solid #ccc',
      borderRadius: '6px',
      fontSize: '14px'
    },
    button: {
      padding: '12px 24px',
      backgroundColor: '#4CAF50',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '16px',
      fontWeight: 'bold',
      marginTop: '20px'
    },
    syncSection: {
      marginTop: '24px',
      padding: '20px',
      backgroundColor: '#1976D2',
      borderRadius: '12px'
    },
    syncButton: {
      padding: '10px 20px',
      margin: '0 5px',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontWeight: 'bold'
    }
  };

  return React.createElement('div', { style: styles.container },
    React.createElement('div', { style: styles.header },
      React.createElement('button', {
        style: styles.backButton,
        onClick: onBack
      }, '← Back')
    ),

    React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '0 16px 16px' } },

      React.createElement('div', { style: styles.mainCard },
        React.createElement('div', { style: styles.cardContent },
          React.createElement('div', {
            style: {
              fontSize: '20px',
              fontWeight: 'bold',
              textAlign: 'center',
              marginBottom: '16px',
              color: '#000'
            }
          }, 'Read/Write ANUR Card'),

          React.createElement('div', { style: styles.modeToggle },
            React.createElement('button', {
              style: {
                ...styles.modeButton,
                backgroundColor: currentMode === 'READ' ? '#8B5CF6' : '#666'
              },
              onClick: () => setCurrentMode('READ')
            }, 'Read Card'),
            React.createElement('button', {
              style: {
                ...styles.modeButton,
                backgroundColor: currentMode === 'WRITE' ? '#616161' : '#666'
              },
              onClick: () => setCurrentMode('WRITE')
            }, 'Write Card')
          ),

          React.createElement('div', {
            style: styles.statusText
          }, currentMode === 'READ' ? nfcStatus : writeStatus),

          cardDetected && currentMode === 'READ' && React.createElement('div', {
            style: { ...styles.statusText, fontWeight: 'bold' }
          }, `Card detected at: ${lastTapTime}`)
        )
      ),

      currentMode === 'READ' ? (
        React.createElement('div', null,
          extractedData?.personalInfo && Object.keys(extractedData.personalInfo).length > 0 &&
          React.createElement('div', { style: { ...styles.dataCard, backgroundColor: '#616161' } },
            React.createElement('div', { style: { ...styles.dataHeader, color: '#fff' } }, '👤 Personal Information'),
            React.createElement('div', { style: styles.dataContent },
              Object.entries(extractedData.personalInfo).map(([key, value]) =>
                React.createElement('div', { key, style: styles.dataRow },
                  React.createElement('div', { style: styles.dataLabel }, `${key}:`),
                  React.createElement('div', { style: styles.dataValue }, value)
                )
              )
            )
          ),

          extractedData?.emergencyContact && Object.keys(extractedData.emergencyContact).length > 0 &&
          React.createElement('div', { style: { ...styles.dataCard, background: 'linear-gradient(135deg, #8B0000, #000000)' } },
            React.createElement('div', { style: { ...styles.dataHeader, color: '#fff' } }, '🚨 Emergency Contact'),
            React.createElement('div', { style: styles.dataContent },
              Object.entries(extractedData.emergencyContact).map(([key, value]) =>
                React.createElement('div', { key, style: styles.dataRow },
                  React.createElement('div', { style: styles.dataLabel }, `${key}:`),
                  React.createElement('div', { style: styles.dataValue }, value)
                )
              )
            )
          ),

          (extractedData?.insuranceInfo?.length > 0 || backendInsuranceData?.policies?.length > 0) && (
            React.createElement('div', null,
              extractedData?.insuranceInfo?.length > 0 && (
                React.createElement('div', null,
                  React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', margin: '20px 0 8px 0', color: '#fff' } }, '📱 CARD INSURANCE DATA'),
                  extractedData.insuranceInfo.map((policy, index) =>
                    React.createElement('div', { key: index, style: { ...styles.dataCard, backgroundColor: '#616161' } },
                      React.createElement('div', { style: { ...styles.dataHeader, color: '#fff' } }, `🏥 Card Policy ${index + 1}`),
                      React.createElement('div', { style: styles.dataContent },
                        Object.entries(policy).map(([key, value]) =>
                          React.createElement('div', { key, style: styles.dataRow },
                            React.createElement('div', { style: styles.dataLabel }, `${key}:`),
                            React.createElement('div', { style: styles.dataValue }, value)
                          )
                        )
                      )
                    )
                  )
                )
              ),

              backendInsuranceData?.policies?.length > 0 && (
                React.createElement('div', null,
                  React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', margin: '20px 0 8px 0', color: '#fff' } }, '🌐 BACKEND INSURANCE DATA'),
                  backendInsuranceData.policies.map((policy, index) =>
                    React.createElement('div', { key: index, style: { ...styles.dataCard, backgroundColor: '#2196F3' } },
                      React.createElement('div', { style: { ...styles.dataHeader, color: '#fff' } }, `🏥 Backend Policy ${index + 1}`),
                      React.createElement('div', { style: styles.dataContent },
                        [
                          ['Policy Number', policy.policyNumber],
                          ['Policy Type', policy.policyType],
                          ['Insurer', policy.insurerName],
                          ['Status', policy.status],
                          ['Premium', `₹${policy.premiumAmount}`],
                          ['Sum Assured', `₹${policy.sumAssured}`]
                        ].map(([key, value]) =>
                          React.createElement('div', { key, style: styles.dataRow },
                            React.createElement('div', { style: styles.dataLabel }, `${key}:`),
                            React.createElement('div', { style: styles.dataValue }, value)
                          )
                        )
                      )
                    )
                  )
                )
              ),

              backendError && React.createElement('div', { style: { ...styles.dataCard, backgroundColor: '#FFEBEE' } },
                React.createElement('div', { style: { ...styles.dataHeader, color: '#D32F2F' } }, '⚠️ Backend Error'),
                React.createElement('div', { style: styles.dataContent },
                  React.createElement('div', { style: { color: '#666' } }, backendError),
                  React.createElement('button', {
                    style: { ...styles.button, backgroundColor: '#D32F2F', marginTop: '10px' },
                    onClick: fetchBackendInsuranceData
                  }, 'Retry')
                )
              )
            )
          ),

          React.createElement('div', { style: { ...styles.dataCard, background: 'linear-gradient(135deg, #000000, #8B0000)' } },
            React.createElement('div', { style: { ...styles.dataHeader, color: '#fff' } }, '📇 VCard Information'),
            React.createElement('div', { style: styles.dataContent },
              React.createElement('div', { style: styles.dataRow },
                React.createElement('div', { style: styles.dataLabel }, 'Website:'),
                React.createElement('div', { style: styles.dataValue }, `https://vcard.tecgs.com:3000/profile/${vCardSlug}`)
              )
            )
          ),

          !backendInsuranceData && !isLoadingBackend && React.createElement('button', {
            onClick: fetchBackendInsuranceData,
            style: { ...styles.button, backgroundColor: '#1976D2', width: '100%' }
          }, '📥 LOAD BACKEND DATA'),

          isLoadingBackend && React.createElement('div', { style: { textAlign: 'center', padding: '20px', color: '#fff' } }, 'Loading backend data...')
        )
      ) : (
        React.createElement('div', null,
          React.createElement('div', { style: styles.syncSection },
            React.createElement('div', { style: { fontSize: '18px', fontWeight: 'bold', marginBottom: '8px', color: '#fff' } }, '🔄 DATA SYNC'),
            React.createElement('div', { style: { color: '#fff', opacity: 0.8, marginBottom: '16px' } }, 'Synchronize insurance policies between card and backend'),

            isLoadingBackend && React.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '16px', color: '#fff' } },
              React.createElement('div', { style: { width: '16px', height: '16px', border: '2px solid #fff', borderTop: '2px solid transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', marginRight: '8px' } }),
              React.createElement('span', null, 'Loading backend data...')
            ),

            syncStatus && React.createElement('div', { style: { marginBottom: '16px', fontWeight: 'bold', color: '#fff' } }, syncStatus),

            syncComparison?.needsSync && React.createElement('div', { style: { backgroundColor: '#FFEB3B', padding: '16px', borderRadius: '8px', marginBottom: '16px' } },
              React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', marginBottom: '8px', color: '#000' } }, '🔄 SYNC REQUIRED'),
              React.createElement('ul', { style: { margin: '0 0 16px 0', paddingLeft: '20px' } },
                syncComparison.differences.map((difference, index) =>
                  React.createElement('li', { key: index, style: { color: '#000' } }, difference)
                )
              ),
              React.createElement('div', { style: { marginTop: '15px' } },
                backendOnlyPolicies && backendOnlyPolicies.length > 0 && React.createElement('div', {
                  style: {
                    backgroundColor: '#f8f9fa',
                    padding: '15px',
                    borderRadius: '8px',
                    marginBottom: '15px',
                    border: '1px solid #e9ecef'
                  }
                },
                  React.createElement('h4', {
                    style: {
                      margin: '0 0 10px 0',
                      color: '#495057',
                      fontSize: '16px'
                    }
                  }, '📋 Data to be written to card:'),
                  React.createElement('div', {
                    style: {
                      maxHeight: '200px',
                      overflowY: 'auto'
                    }
                  },
                    backendOnlyPolicies.map((policy, index) =>
                      React.createElement('div', {
                        key: index,
                        style: {
                          backgroundColor: '#fff',
                          padding: '10px',
                          marginBottom: '8px',
                          borderRadius: '6px',
                          border: '1px solid #dee2e6'
                        }
                      },
                        React.createElement('div', {
                          style: {
                            fontWeight: 'bold',
                            color: '#8B5CF6',
                            marginBottom: '5px'
                          }
                        }, `Policy ${index + 1}: ${policy.policyNumber}`),
                        React.createElement('div', {
                          style: {
                            fontSize: '12px',
                            color: '#6c757d'
                          }
                        },
                          React.createElement('div', null, `Policyholder: ${policy.policyHolderName || 'N/A'}`),
                          React.createElement('div', null, `Age: ${policy.age || 'N/A'}`),
                          React.createElement('div', null, `Insurer: ${policy.insurerName}`),
                          React.createElement('div', null, `Policy Type: ${policy.policyType}`),
                          React.createElement('div', null, `Premium: ₹${policy.premiumAmount}`),
                          React.createElement('div', null, `Sum Assured: ₹${policy.sumAssured}`),
                          React.createElement('div', null, `Policy Start: ${policy.policyStartDate || 'N/A'}`),
                          React.createElement('div', null, `Policy End: ${policy.policyEndDate || 'N/A'}`),
                          React.createElement('div', null, `Status: ${policy.status}`),
                          React.createElement('div', null, `Contact: ${policy.contactEmail || 'N/A'}`),
                          React.createElement('div', null, `Mobile: ${policy.contactPhone || 'N/A'}`)
                        )
                      )
                    )
                  )
                ),
                React.createElement('div', { style: { display: 'flex', justifyContent: 'center' } },
                  React.createElement('button', {
                    onClick: syncBackendToCard,
                    disabled: isSyncing,
                    style: { ...styles.syncButton, backgroundColor: '#2196F3', color: '#fff' }
                  }, 'SMART Sync')
                )
              )
            ),

            syncComparison && !syncComparison.needsSync && React.createElement('div', { style: { backgroundColor: '#E8F5E8', padding: '16px', borderRadius: '8px' } },
              React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', color: '#4CAF50' } }, '✅ DATA IN SYNC'),
              React.createElement('div', { style: { color: '#666' } }, 'Card and backend data are synchronized')
            ),

            !backendInsuranceData && !isLoadingBackend && React.createElement('button', {
              onClick: fetchBackendInsuranceData,
              style: { ...styles.button, backgroundColor: '#1976D2', width: '100%' }
            }, 'LOAD BACKEND DATA')
          )
        )
      )
    )
  );
}

module.exports = SCMasterScreen;