describe('getPrinters', () => {
    it('should load', () => {
        const printer = require("../");
        expect(printer).toBeDefined();
    })

    it('should get printers', () => {
        const printer = require("../");
        expect(typeof(printer.getPrinters())).toEqual('object');
    })
})
