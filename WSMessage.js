// Class WSMessage для работы с получаемыми и отправляемыми сообщениями через WebSocket

class WSMessage {
    constructor(type, request, data) {
        this.type = type;
        this.request = request;
        this.data = data;
    }
}