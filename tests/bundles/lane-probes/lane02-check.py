import sys, zipfile, xml.dom.minidom, re
for f in sys.argv[1:]:
    z = zipfile.ZipFile(f)
    bad = z.testzip()
    res = []
    for n in z.namelist():
        try: xml.dom.minidom.parseString(z.read(n)); ok = 'ok'
        except Exception as e: ok = 'XML ERROR: ' + str(e)[:60]
        if n.endswith('document.xml') or ok != 'ok': res.append(f'{n}: {ok}')
    doc = z.read('word/document.xml').decode()
    print(f.split('/')[-1], 'CRC ok' if bad is None else 'CRC BAD ' + bad, '|', '; '.join(res), '| w:tr in tables:', len(re.findall('<w:tr>', doc)), 'w:tbl:', doc.count('<w:tbl>'))
