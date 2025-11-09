const React = require('react');
const { ipcRenderer } = require('electron');
const SCMasterScreen = require('./SCMasterScreen.jsx');

function App() {
  const [cardData, setCardData] = React.useState(null);
  const [status, setStatus] = React.useState('waiting');
  const [message, setMessage] = React.useState('Waiting for card...');
  const [activeTab, setActiveTab] = React.useState('read'); // Start with read tab
  const [currentMode, setCurrentMode] = React.useState('READ');
  const [isWritePending, setIsWritePending] = React.useState(false);

  // Form states for write operations
  const [vCardSlug, setVCardSlug] = React.useState('user-' + Date.now());
  const [personalInfo, setPersonalInfo] = React.useState({
    'Full Name': 'Test User',
    'Phone': '1234567890',
    'Email': 'test@example.com',
    'Organization': 'TECGS',
    'Job Title': 'Engineer',
    'Address': '123 Main St'
  });
  const [emergencyContact, setEmergencyContact] = React.useState({
    name: 'Emergency Contact',
    mobile: '9876543210',
    bloodGroup: 'O+',
    location: 'Chennai',
    relationship: 'Family'
  });
  const [insurancePolicies, setInsurancePolicies] = React.useState([]);
  const [currentPolicy, setCurrentPolicy] = React.useState({
    policyholder: '',
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
  });

  // Listen for card detection
  React.useEffect(() => {
    ipcRenderer.on('card-detected', (event, data) => {
      console.log('[App] Card data received:', data);
      
      if (data.status === 'removed') {
        setStatus('removed');
        setMessage('Card removed');
        setCardData(null);
        setIsWritePending(false);
      } else if (data.mode === 'READ') {
        setCardData(data);
        setStatus('success');
        setMessage('Card read successfully');
      } else if (data.mode === 'WRITE') {
        if (data.status === 'success') {
          setStatus('success');
          setMessage(`Write successful! ${data.recordsWritten} records written`);
          setIsWritePending(false);
        } else if (data.status === 'error') {
          setStatus('error');
          setMessage(`Write failed: ${data.message}`);
          setIsWritePending(false);
        }
      }
    });

    ipcRenderer.on('card-error', (event, error) => {
      setStatus('error');
      setMessage(error);
      setCardData(null);
      setIsWritePending(false);
    });

    return () => {
      ipcRenderer.removeAllListeners('card-detected');
      ipcRenderer.removeAllListeners('card-error');
    };
  }, []);

  // Switch mode when tab changes
  React.useEffect(() => {
    const newMode = activeTab === 'read' ? 'READ' : 'WRITE';
    ipcRenderer.invoke('set-mode', newMode).then(() => {
      setCurrentMode(newMode);
      console.log('[App] Mode changed to:', newMode);
    });
  }, [activeTab]);

  const getStatusClass = () => {
    if (status === 'success') return 'status-success';
    if (status === 'error') return 'status-error';
    if (status === 'removed') return 'status-removed';
    return 'status-waiting';
  };

  // Write operation handler
  const handleWriteToCard = async () => {
    try {
      setIsWritePending(true);
      setStatus('waiting');
      setMessage('Preparing to write... Please tap your card now');

      const data = {
        vCardUrl: `https://vcard.tecgs.com:3000/profile/${vCardSlug}`,
        personalInfo,
        emergencyContact,
        insurancePolicies
      };

      console.log('[App] Preparing write with:', {
        vCardUrl: data.vCardUrl,
        hasPersonal: Object.keys(personalInfo).length > 0,
        hasEmergency: !!emergencyContact.name,
        policiesCount: insurancePolicies.length
      });

      const result = await ipcRenderer.invoke('prepare-write', data);
      console.log('[App] Write prepared:', result);
      setMessage(result.message || 'Data ready. Tap your card to write.');
      
    } catch (error) {
      setStatus('error');
      setMessage('Failed to prepare write: ' + error.message);
      setIsWritePending(false);
    }
  };

  const handleCancelWrite = async () => {
    try {
      await ipcRenderer.invoke('cancel-write');
      setIsWritePending(false);
      setMessage('Write cancelled');
    } catch (error) {
      console.error('Failed to cancel write:', error);
    }
  };

  const handleAddPolicy = () => {
    if (currentPolicy.policyNumber && currentPolicy.policyholder) {
      setInsurancePolicies([...insurancePolicies, { ...currentPolicy }]);
      setCurrentPolicy({
        policyholder: '',
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
      });
      setMessage(`Policy ${currentPolicy.policyNumber} added`);
    } else {
      setMessage('Please fill Policy Number and Policyholder');
    }
  };

  const handleRemovePolicy = (index) => {
    const newPolicies = [...insurancePolicies];
    newPolicies.splice(index, 1);
    setInsurancePolicies(newPolicies);
  };

  // Render helper for Read tab
  const renderReadTab = () => {
    if (!cardData || cardData.status === 'removed') {
      return React.createElement('div', { className: 'empty-state' },
        React.createElement('div', { style: { fontSize: '64px', marginBottom: '20px' } }, '💳'),
        React.createElement('div', { style: { fontSize: '18px', color: '#999' } },
          status === 'removed' ? 'Card Removed' : 'Place your card on the reader'
        )
      );
    }

    return React.createElement('div', null,
      // Card Info Section
      React.createElement('div', {
        style: {
          backgroundColor: '#333',
          padding: '20px',
          borderRadius: '12px',
          marginBottom: '20px'
        }
      },
        React.createElement('h3', { style: { marginBottom: '15px', color: '#fff' } }, '📇 Card Information'),
        React.createElement('div', { style: { color: '#ccc' } },
          React.createElement('p', null, `UID: ${cardData.uid || 'N/A'}`),
          React.createElement('p', null, `Reader: ${cardData.reader || 'N/A'}`),
          React.createElement('p', null, `Time: ${new Date(cardData.timestamp).toLocaleString()}`)
        )
      ),

      // Personal Information
      cardData.personalInfo && Object.keys(cardData.personalInfo).length > 0 &&
        React.createElement('div', {
          style: {
            backgroundColor: '#616161',
            borderRadius: '12px',
            overflow: 'hidden',
            marginBottom: '20px'
          }
        },
          React.createElement('div', {
            style: {
              padding: '16px 20px',
              color: '#fff',
              fontWeight: 'bold',
              fontSize: '18px'
            }
          }, '👤 Personal Information'),
          React.createElement('div', { style: { padding: '20px', backgroundColor: '#fff' } },
            Object.entries(cardData.personalInfo).map(([key, value]) =>
              React.createElement('div', {
                key,
                style: {
                  display: 'flex',
                  padding: '8px 0',
                  borderBottom: '1px solid #f0f0f0'
                }
              },
                React.createElement('div', {
                  style: { flex: '0 0 35%', color: '#666', fontWeight: '500' }
                }, key + ':'),
                React.createElement('div', {
                  style: { flex: '1', color: '#333' }
                }, value)
              )
            )
          )
        ),

      // Emergency Contact
      cardData.emergencyContact && Object.keys(cardData.emergencyContact).length > 0 &&
        React.createElement('div', {
          style: {
            background: 'linear-gradient(135deg, #8B0000, #000000)',
            borderRadius: '12px',
            overflow: 'hidden',
            marginBottom: '20px'
          }
        },
          React.createElement('div', {
            style: {
              padding: '16px 20px',
              color: '#fff',
              fontWeight: 'bold',
              fontSize: '18px'
            }
          }, '🚨 Emergency Contact'),
          React.createElement('div', { style: { padding: '20px', backgroundColor: '#fff' } },
            Object.entries(cardData.emergencyContact).map(([key, value]) =>
              React.createElement('div', {
                key,
                style: {
                  display: 'flex',
                  padding: '8px 0',
                  borderBottom: '1px solid #f0f0f0'
                }
              },
                React.createElement('div', {
                  style: { flex: '0 0 35%', color: '#666', fontWeight: '500' }
                }, key + ':'),
                React.createElement('div', {
                  style: { flex: '1', color: '#333' }
                }, value)
              )
            )
          )
        ),

      // Insurance Policies
      cardData.insurancePolicies && cardData.insurancePolicies.length > 0 &&
        cardData.insurancePolicies.map((policy, index) =>
          React.createElement('div', {
            key: index,
            style: {
              backgroundColor: '#616161',
              borderRadius: '12px',
              overflow: 'hidden',
              marginBottom: '20px'
            }
          },
            React.createElement('div', {
              style: {
                padding: '16px 20px',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '18px'
              }
            }, `🏥 Insurance Policy ${index + 1}`),
            React.createElement('div', { style: { padding: '20px', backgroundColor: '#fff' } },
              Object.entries(policy).map(([key, value]) =>
                React.createElement('div', {
                  key,
                  style: {
                    display: 'flex',
                    padding: '8px 0',
                    borderBottom: '1px solid #f0f0f0'
                  }
                },
                  React.createElement('div', {
                    style: { flex: '0 0 35%', color: '#666', fontWeight: '500' }
                  }, key + ':'),
                  React.createElement('div', {
                    style: { flex: '1', color: '#333' }
                  }, value)
                )
              )
            )
          )
        ),

      // VCard URL
      cardData.vCardUrl &&
        React.createElement('div', {
          style: {
            background: 'linear-gradient(135deg, #000000, #8B0000)',
            borderRadius: '12px',
            overflow: 'hidden'
          }
        },
          React.createElement('div', {
            style: {
              padding: '16px 20px',
              color: '#fff',
              fontWeight: 'bold',
              fontSize: '18px'
            }
          }, '🔗 VCard Information'),
          React.createElement('div', { style: { padding: '20px', backgroundColor: '#fff' } },
            React.createElement('div', {
              style: {
                display: 'flex',
                padding: '8px 0'
              }
            },
              React.createElement('div', {
                style: { flex: '0 0 35%', color: '#666', fontWeight: '500' }
              }, 'Website:'),
              React.createElement('div', {
                style: { flex: '1', color: '#0066cc', wordBreak: 'break-all' }
              }, cardData.vCardUrl)
            )
          )
        )
    );
  };

  // Render helper for Write tab
  const renderWriteTab = () => {
    const inputStyle = {
      padding: '10px',
      backgroundColor: '#333',
      color: '#fff',
      border: '1px solid #555',
      borderRadius: '6px',
      fontSize: '14px'
    };

    const sectionStyle = {
      backgroundColor: '#222',
      padding: '20px',
      borderRadius: '12px',
      marginBottom: '20px'
    };

    return React.createElement('div', null,
      // VCard URL Section
      React.createElement('div', { style: sectionStyle },
        React.createElement('h3', { style: { marginBottom: '15px', color: '#fff' } }, '📇 VCard URL'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          React.createElement('span', { style: { color: '#ccc' } }, 'https://vcard.tecgs.com:3000/profile/'),
          React.createElement('input', {
            type: 'text',
            value: vCardSlug,
            onChange: (e) => setVCardSlug(e.target.value),
            placeholder: 'user-slug',
            style: { ...inputStyle, flex: 1 }
          })
        )
      ),

      // Personal Information Section
      React.createElement('div', { style: sectionStyle },
        React.createElement('h3', { style: { marginBottom: '15px', color: '#fff' } }, '👤 Personal Information'),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
          React.createElement('input', {
            type: 'text',
            placeholder: 'Full Name',
            value: personalInfo['Full Name'],
            onChange: (e) => setPersonalInfo({ ...personalInfo, 'Full Name': e.target.value }),
            style: inputStyle
          }),
          React.createElement('input', {
            type: 'text',
            placeholder: 'Phone',
            value: personalInfo['Phone'],
            onChange: (e) => setPersonalInfo({ ...personalInfo, 'Phone': e.target.value }),
            style: inputStyle
          }),
          React.createElement('input', {
            type: 'email',
            placeholder: 'Email',
            value: personalInfo['Email'],
            onChange: (e) => setPersonalInfo({ ...personalInfo, 'Email': e.target.value }),
            style: inputStyle
          }),
          React.createElement('input', {
            type: 'text',
            placeholder: 'Organization',
            value: personalInfo['Organization'],
            onChange: (e) => setPersonalInfo({ ...personalInfo, 'Organization': e.target.value }),
            style: inputStyle
          }),
          React.createElement('input', {
            type: 'text',
            placeholder: 'Job Title',
            value: personalInfo['Job Title'],
            onChange: (e) => setPers
            style: { margin: '5px 0 0 0', opacity: 0.9, fontSize: '14px' }
      }, `Mode: ${currentMode} | Status: ${status}`)
    ),

    // Tab Navigation
    React.createElement('div', {
      style: {
        display: 'flex',
        borderBottom: '2px solid #444',
        backgroundColor: '#1a1a1a'
      }
    },
      React.createElement('button', {
        onClick: () => setActiveTab('read'),
        style: {
          padding: '15px 30px',
          backgroundColor: activeTab === 'read' ? '#333' : '#1a1a1a',
          color: activeTab === 'read' ? '#8B5CF6' : '#999',
          border: 'none',
          borderBottom: activeTab === 'read' ? '3px solid #8B5CF6' : 'none',
          cursor: 'pointer',
          fontSize: '16px',
          fontWeight: 'bold',
          transition: 'all 0.3s'
        }
      }, '📖 Read Card'),
      React.createElement('button', {
        onClick: () => setActiveTab('write'),
        style: {
          padding: '15px 30px',
          backgroundColor: activeTab === 'write' ? '#333' : '#1a1a1a',
          color: activeTab === 'write' ? '#28a745' : '#999',
          border: 'none',
          borderBottom: activeTab === 'write' ? '3px solid #28a745' : 'none',
          cursor: 'pointer',
          fontSize: '16px',
          fontWeight: 'bold',
          transition: 'all 0.3s'
        }
      }, '✏️ Write Card')
    ),

    // Status Message Bar
    React.createElement('div', {
      className: getStatusClass(),
      style: {
        padding: '12px 20px',
        backgroundColor: status === 'success' ? '#28a745' :
                        status === 'error' ? '#dc3545' :
                        status === 'removed' ? '#6c757d' : '#ffc107',
        color: '#fff',
        fontWeight: 'bold',
        textAlign: 'center'
      }
    }, message),

    // Main Content Area
    React.createElement('div', {
      style: {
        flex: 1,
        overflowY: 'auto',
        padding: '20px',
        backgroundColor: '#111'
      }
    },
      activeTab === 'read' ? renderReadTab() : renderWriteTab()
    )
  );
}

module.exports = App;