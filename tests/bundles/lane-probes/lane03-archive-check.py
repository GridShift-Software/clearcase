import sys, zipfile, zlib, io, xml.dom.minidom, json, os
d=sys.argv[1]
big=open(os.path.join(d,'big.bin'),'rb').read()
print('crc agree', zlib.crc32(big)==int(open(os.path.join(d,'big.crc')).read()))
for n in sorted(os.listdir(d)):
    if not (n.endswith('.zip') or n.endswith('.docx')): continue
    p=os.path.join(d,n)
    try:
        z=zipfile.ZipFile(p); bad=z.testzip()
        names=[i.filename for i in z.infolist()]
        xmlbad=[]
        for i in z.infolist():
            if i.filename.endswith('.xml') or i.filename.endswith('.rels'):
                try: xml.dom.minidom.parseString(z.read(i))
                except Exception as e: xmlbad.append((i.filename, type(e).__name__, str(e)[:60]))
        print(n, 'zip ok' if bad is None else 'zip BAD '+bad, len(names), 'entries', 'utf8flag' , [bool(i.flag_bits & 0x800) for i in z.infolist()][:3], 'xml errors', xmlbad)
        if n=='odd-names.zip': print('  names as read by python zipfile', [x.encode('unicode_escape').decode() for x in names])
    except Exception as e:
        print(n, 'OPEN FAIL', type(e).__name__, str(e)[:80])
print(open(os.path.join(d,'large.json')).read())
print(open(os.path.join(d,'caselines-link.json')).read())
