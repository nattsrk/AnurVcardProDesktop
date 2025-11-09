const React = require('react');
const ReactDOM = require('react-dom');
const path = require('path');
const App = require(path.join(__dirname, 'App.jsx'));

ReactDOM.render(
  React.createElement(App),
  document.getElementById('root')
);
