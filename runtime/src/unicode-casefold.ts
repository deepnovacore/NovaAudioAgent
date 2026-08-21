import {toLowerPinned} from './unicode-normalize.js'

/*
 * Unicode 15.0 full-casefold mappings whose result differs from lowercase.
 * Generated from the same CPython Unicode database as the project fixtures. Ordinary mappings use
 * the already-pinned per-code-point lowercase helper; processing one scalar at a time deliberately
 * avoids JavaScript's contextual final-sigma lowercasing.
 */
const CASEFOLD_EXCEPTIONS = 'b5:3bc;df:73,73;149:2bc,6e;17f:73;1f0:6a,30c;345:3b9;390:3b9,308,301;3b0:3c5,308,301;3c2:3c3;3d0:3b2;3d1:3b8;3d5:3c6;3d6:3c0;3f0:3ba;3f1:3c1;3f5:3b5;587:565,582;13a0:13a0;13a1:13a1;13a2:13a2;13a3:13a3;13a4:13a4;13a5:13a5;13a6:13a6;13a7:13a7;13a8:13a8;13a9:13a9;13aa:13aa;13ab:13ab;13ac:13ac;13ad:13ad;13ae:13ae;13af:13af;13b0:13b0;13b1:13b1;13b2:13b2;13b3:13b3;13b4:13b4;13b5:13b5;13b6:13b6;13b7:13b7;13b8:13b8;13b9:13b9;13ba:13ba;13bb:13bb;13bc:13bc;13bd:13bd;13be:13be;13bf:13bf;13c0:13c0;13c1:13c1;13c2:13c2;13c3:13c3;13c4:13c4;13c5:13c5;13c6:13c6;13c7:13c7;13c8:13c8;13c9:13c9;13ca:13ca;13cb:13cb;13cc:13cc;13cd:13cd;13ce:13ce;13cf:13cf;13d0:13d0;13d1:13d1;13d2:13d2;13d3:13d3;13d4:13d4;13d5:13d5;13d6:13d6;13d7:13d7;13d8:13d8;13d9:13d9;13da:13da;13db:13db;13dc:13dc;13dd:13dd;13de:13de;13df:13df;13e0:13e0;13e1:13e1;13e2:13e2;13e3:13e3;13e4:13e4;13e5:13e5;13e6:13e6;13e7:13e7;13e8:13e8;13e9:13e9;13ea:13ea;13eb:13eb;13ec:13ec;13ed:13ed;13ee:13ee;13ef:13ef;13f0:13f0;13f1:13f1;13f2:13f2;13f3:13f3;13f4:13f4;13f5:13f5;13f8:13f0;13f9:13f1;13fa:13f2;13fb:13f3;13fc:13f4;13fd:13f5;1c80:432;1c81:434;1c82:43e;1c83:441;1c84:442;1c85:442;1c86:44a;1c87:463;1c88:a64b;1e96:68,331;1e97:74,308;1e98:77,30a;1e99:79,30a;1e9a:61,2be;1e9b:1e61;1e9e:73,73;1f50:3c5,313;1f52:3c5,313,300;1f54:3c5,313,301;1f56:3c5,313,342;1f80:1f00,3b9;1f81:1f01,3b9;1f82:1f02,3b9;1f83:1f03,3b9;1f84:1f04,3b9;1f85:1f05,3b9;1f86:1f06,3b9;1f87:1f07,3b9;1f88:1f00,3b9;1f89:1f01,3b9;1f8a:1f02,3b9;1f8b:1f03,3b9;1f8c:1f04,3b9;1f8d:1f05,3b9;1f8e:1f06,3b9;1f8f:1f07,3b9;1f90:1f20,3b9;1f91:1f21,3b9;1f92:1f22,3b9;1f93:1f23,3b9;1f94:1f24,3b9;1f95:1f25,3b9;1f96:1f26,3b9;1f97:1f27,3b9;1f98:1f20,3b9;1f99:1f21,3b9;1f9a:1f22,3b9;1f9b:1f23,3b9;1f9c:1f24,3b9;1f9d:1f25,3b9;1f9e:1f26,3b9;1f9f:1f27,3b9;1fa0:1f60,3b9;1fa1:1f61,3b9;1fa2:1f62,3b9;1fa3:1f63,3b9;1fa4:1f64,3b9;1fa5:1f65,3b9;1fa6:1f66,3b9;1fa7:1f67,3b9;1fa8:1f60,3b9;1fa9:1f61,3b9;1faa:1f62,3b9;1fab:1f63,3b9;1fac:1f64,3b9;1fad:1f65,3b9;1fae:1f66,3b9;1faf:1f67,3b9;1fb2:1f70,3b9;1fb3:3b1,3b9;1fb4:3ac,3b9;1fb6:3b1,342;1fb7:3b1,342,3b9;1fbc:3b1,3b9;1fbe:3b9;1fc2:1f74,3b9;1fc3:3b7,3b9;1fc4:3ae,3b9;1fc6:3b7,342;1fc7:3b7,342,3b9;1fcc:3b7,3b9;1fd2:3b9,308,300;1fd3:3b9,308,301;1fd6:3b9,342;1fd7:3b9,308,342;1fe2:3c5,308,300;1fe3:3c5,308,301;1fe4:3c1,313;1fe6:3c5,342;1fe7:3c5,308,342;1ff2:1f7c,3b9;1ff3:3c9,3b9;1ff4:3ce,3b9;1ff6:3c9,342;1ff7:3c9,342,3b9;1ffc:3c9,3b9;ab70:13a0;ab71:13a1;ab72:13a2;ab73:13a3;ab74:13a4;ab75:13a5;ab76:13a6;ab77:13a7;ab78:13a8;ab79:13a9;ab7a:13aa;ab7b:13ab;ab7c:13ac;ab7d:13ad;ab7e:13ae;ab7f:13af;ab80:13b0;ab81:13b1;ab82:13b2;ab83:13b3;ab84:13b4;ab85:13b5;ab86:13b6;ab87:13b7;ab88:13b8;ab89:13b9;ab8a:13ba;ab8b:13bb;ab8c:13bc;ab8d:13bd;ab8e:13be;ab8f:13bf;ab90:13c0;ab91:13c1;ab92:13c2;ab93:13c3;ab94:13c4;ab95:13c5;ab96:13c6;ab97:13c7;ab98:13c8;ab99:13c9;ab9a:13ca;ab9b:13cb;ab9c:13cc;ab9d:13cd;ab9e:13ce;ab9f:13cf;aba0:13d0;aba1:13d1;aba2:13d2;aba3:13d3;aba4:13d4;aba5:13d5;aba6:13d6;aba7:13d7;aba8:13d8;aba9:13d9;abaa:13da;abab:13db;abac:13dc;abad:13dd;abae:13de;abaf:13df;abb0:13e0;abb1:13e1;abb2:13e2;abb3:13e3;abb4:13e4;abb5:13e5;abb6:13e6;abb7:13e7;abb8:13e8;abb9:13e9;abba:13ea;abbb:13eb;abbc:13ec;abbd:13ed;abbe:13ee;abbf:13ef;fb00:66,66;fb01:66,69;fb02:66,6c;fb03:66,66,69;fb04:66,66,6c;fb05:73,74;fb06:73,74;fb13:574,576;fb14:574,565;fb15:574,56b;fb16:57e,576;fb17:574,56d'

const exceptionMap: ReadonlyMap<number, string> = new Map(
  CASEFOLD_EXCEPTIONS.split(';').map(entry => {
    const [source, folded] = entry.split(':') as [string, string]
    return [
      Number.parseInt(source, 16),
      String.fromCodePoint(...folded.split(',').map(value => Number.parseInt(value, 16))),
    ] as const
  }),
)

/** CPython `str.casefold()` pinned to Unicode 15.0 for well-formed scalar text. */
export function casefoldLikePython(text: string): string {
  let result = ''
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    result += exceptionMap.get(codePoint) ?? toLowerPinned(character)
  }
  return result
}
