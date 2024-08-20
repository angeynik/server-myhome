const express = require('express');
const app = express();
const PORT = process.env.SERVER_PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(PORT, () => {
  console.log(`MyHome Server is running on port ${PORT}`);
});